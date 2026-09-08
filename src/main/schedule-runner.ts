// schedule-runner.ts — Scan schedule-*.md files, match cron, build commands
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

/** The `cli:` block of a schedule's frontmatter — flags passed through to claude. */
export type ScheduleCli = Record<string, string>;

/** A frontmatter value: a scalar, or the nested map under a bare key. */
export type FrontmatterValue = string | Record<string, string>;

/** A schedule-*.md file, parsed. */
export interface Schedule {
  file: string;
  filePath: string;
  projectPath: string;
  folder: string;
  name: string;
  cron: string;
  slug: string;
  cli: ScheduleCli;
  prompt: string;
}

/** The log surface this module uses — electron-log satisfies it. */
export interface ScheduleLogger {
  info(message: string): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/** Parse YAML-like frontmatter from a markdown file (simple key: value parser). */
export function parseFrontmatter(content: string): { meta: Record<string, FrontmatterValue>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: content.trim() };

  const meta: Record<string, FrontmatterValue> = {};
  let currentKey: string | null = null;
  const nested: Record<string, Record<string, string>> = {};

  for (const line of match[1].split('\n')) {
    if (currentKey && line.match(/^\s+/) && line.includes(':')) {
      const m = line.match(/^\s+([^:]+):\s*(.*)$/);
      if (m && !m[1].trim().startsWith('#')) {
        if (!nested[currentKey]) nested[currentKey] = {};
        nested[currentKey][m[1].trim()] = m[2].trim();
      }
      continue;
    }
    const kv = line.match(/^([^:]+):\s*(.*)$/);
    if (kv) {
      const key = kv[1].trim();
      const val = kv[2].trim();
      if (val === '' || val === undefined) {
        currentKey = key;
      } else {
        meta[key] = val;
        currentKey = null;
      }
    }
  }
  for (const [k, v] of Object.entries(nested)) {
    meta[k] = v;
  }
  return { meta, body: match[2].trim() };
}

// Check if a cron field matches a value. Supports *, ranges (1-5), lists (1,3,5), and steps.
function cronFieldMatches(field: string, value: number): boolean {
  if (field === '*') return true;
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    return value % step === 0;
  }
  if (field.includes(',')) {
    return field.split(',').some(f => cronFieldMatches(f.trim(), value));
  }
  if (field.includes('-')) {
    const [lo, hi] = field.split('-').map(Number);
    return value >= lo && value <= hi;
  }
  return parseInt(field, 10) === value;
}

/** Check if a 5-field cron expression matches the current time. */
export function cronMatches(cronExpr: string, now: Date): boolean {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minute, hour, dom, month, dow] = parts;
  return (
    cronFieldMatches(minute, now.getMinutes()) &&
    cronFieldMatches(hour, now.getHours()) &&
    cronFieldMatches(dom, now.getDate()) &&
    cronFieldMatches(month, now.getMonth() + 1) &&
    cronFieldMatches(dow, now.getDay())
  );
}

/**
 * Resolve a project folder name to its project path from the SQLite cache.
 * Returns a Map<folder, projectPath>, or an empty Map if the cache is
 * unavailable (e.g. in tests that don't load the native DB binding).
 */
function loadFolderMetaMap(): Map<string, string> {
  try {
    // Lazy require so importing schedule-runner.ts never forces the native
    // better-sqlite3 binding to load (keeps the module test-friendly). esbuild
    // leaves this call in place because it is not a static import.
    const { getAllFolderMeta } = require('./db.js') as typeof import('./db.js');
    const meta = getAllFolderMeta();
    const map = new Map<string, string>();
    for (const [folder, row] of meta) {
      if (row && row.projectPath) map.set(folder, row.projectPath);
    }
    return map;
  } catch {
    return new Map<string, string>();
  }
}

/** Read a project folder's first JSONL just enough to extract its cwd. */
function readProjectPathFromJsonl(folderPath: string): string | null {
  try {
    const jsonlFiles = fs.readdirSync(folderPath).filter(f => f.endsWith('.jsonl'));
    for (const jf of jsonlFiles) {
      const head = fs.readFileSync(path.join(folderPath, jf), 'utf8').slice(0, 4000);
      for (const line of head.split('\n').filter(Boolean)) {
        try {
          const entry = JSON.parse(line) as { cwd?: string };
          if (entry.cwd) return entry.cwd;
        } catch {}
      }
    }
  } catch {}
  return null;
}

/** Scan all projects for schedule-*.md files and return parsed schedule objects. */
export function scanSchedules(log?: ScheduleLogger): Schedule[] {
  const schedules: Schedule[] = [];
  try {
    if (!fs.existsSync(PROJECTS_DIR)) return schedules;
    const folders = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory());

    // Prefer the cached folder→projectPath mapping; only read JSONLs for
    // folders genuinely missing from the cache. This avoids re-reading 4KB of
    // every JSONL of every project on each 60s tick.
    const folderMeta = loadFolderMetaMap();

    for (const folder of folders) {
      const folderPath = path.join(PROJECTS_DIR, folder.name);
      let projectPath: string | null = folderMeta.get(folder.name) || null;
      if (!projectPath) {
        projectPath = readProjectPathFromJsonl(folderPath);
      }
      if (!projectPath) continue;

      const commandsDir = path.join(projectPath, '.claude', 'commands');
      try {
        if (!fs.existsSync(commandsDir)) continue;
        const files = fs.readdirSync(commandsDir).filter(f => f.startsWith('schedule-') && f.endsWith('.md'));
        for (const file of files) {
          try {
            const content = fs.readFileSync(path.join(commandsDir, file), 'utf8');
            const { meta, body } = parseFrontmatter(content);
            const cron = typeof meta.cron === 'string' ? meta.cron : null;
            if (!cron || !body) continue;
            if (meta.enabled === 'false') continue;
            const name = typeof meta.name === 'string' ? meta.name : file;
            const slug = typeof meta.slug === 'string'
              ? meta.slug
              : file.replace(/^schedule-/, '').replace(/\.md$/, '');
            schedules.push({
              file, filePath: path.join(commandsDir, file),
              projectPath, folder: folder.name,
              name, cron, slug,
              cli: (typeof meta.cli === 'object' ? meta.cli : {}), prompt: body,
            });
          } catch (err) {
            if (log) log.warn(`[schedule] Failed to parse ${file}:`, (err as Error).message);
          }
        }
      } catch {}
    }
  } catch (err) {
    if (log) log.error('[schedule] Error scanning schedules:', err);
  }
  return schedules;
}

/** Create a pre-seeded JSONL session file with user message and slug for grouping. */
export function createScheduleSession(schedule: Schedule): { sessionId: string; jsonlPath: string } {
  const sessionId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const claudeProjectDir = path.join(PROJECTS_DIR, schedule.folder);

  fs.mkdirSync(claudeProjectDir, { recursive: true });
  const jsonlPath = path.join(claudeProjectDir, `${sessionId}.jsonl`);

  const msgId = crypto.randomUUID();
  const lines = [
    JSON.stringify({ type: 'user', parentUuid: null, uuid: msgId, sessionId, cwd: schedule.projectPath, slug: schedule.slug, timestamp, message: { role: 'user', content: 'Scheduled Task: ' + schedule.prompt } }),
  ];
  fs.writeFileSync(jsonlPath, lines.join('\n') + '\n');
  return { sessionId, jsonlPath };
}

// Defense-in-depth: reject control chars in frontmatter values (shell-quoter is the real defense)
function isSafeScalar(s: unknown): boolean {
  if (s == null) return true;
  return !/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(String(s));
}

function assertSafe(field: string, value: string): string {
  if (!isSafeScalar(value)) {
    throw new Error(`Schedule field "${field}" contains unsafe characters`);
  }
  return value;
}

/**
 * Build the argv for a scheduled claude invocation.
 * Returns `{ claudeArgs: string[] }` — a plain argv array, with zero shell interpretation.
 * The caller is responsible for shell-quoting when constructing a shell command string.
 */
export function buildScheduleCommand(sessionId: string, schedule: Partial<Schedule>): { claudeArgs: string[] } {
  const cli: ScheduleCli = schedule.cli || {};
  const args = [
    '--resume', assertSafe('sessionId', sessionId),
    '-p', 'Run the scheduled task',
    '--permission-mode', assertSafe('permission-mode', cli['permission-mode'] || 'acceptEdits'),
  ];

  if (cli.model) args.push('--model', assertSafe('model', cli.model));
  if (cli['max-budget-usd']) {
    const budget = String(cli['max-budget-usd']).trim();
    if (!/^\d+(\.\d+)?$/.test(budget)) {
      throw new Error(`Schedule field "max-budget-usd" must be a number, got: ${cli['max-budget-usd']}`);
    }
    args.push('--max-budget-usd', budget);
  }
  args.push('--allowedTools', assertSafe('allowed-tools', cli['allowed-tools'] || 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch'));
  if (cli['append-system-prompt']) {
    // Allow newlines in prompt text, but not control chars other than \n, \r, \t
    const prompt = String(cli['append-system-prompt']);
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(prompt)) {
      throw new Error('Schedule field "append-system-prompt" contains unsafe characters');
    }
    args.push('--append-system-prompt', prompt);
  }
  if (cli['add-dirs']) {
    for (const dir of String(cli['add-dirs']).split(',').map(d => d.trim()).filter(Boolean)) {
      args.push('--add-dir', assertSafe('add-dirs', dir));
    }
  }

  return { claudeArgs: args };
}

/** Spawns one scheduled run; `onExit` releases the task's re-entrancy lock. */
export type RunScheduledCommand = (
  claudeArgs: string[],
  cwd: string,
  name: string,
  onExit: () => void,
) => void;

/**
 * Start the cron loop. Checks every 60 seconds.
 * Returns the function that stops it.
 */
export function startScheduler(log: ScheduleLogger, runCommand: RunScheduledCommand): () => void {
  let running = true;
  const runningTasks = new Set<string>();

  function tick() {
    if (!running) return;
    const now = new Date();
    const schedules = scanSchedules(log);

    for (const schedule of schedules) {
      if (!cronMatches(schedule.cron, now)) continue;
      const taskKey = `${schedule.folder}:${schedule.slug}`;
      if (runningTasks.has(taskKey)) {
        log.info(`[schedule] Skipping ${schedule.name} — still running from previous trigger`);
        continue;
      }

      log.info(`[schedule] Triggering: ${schedule.name} (${schedule.cron})`);
      try {
        const { sessionId } = createScheduleSession(schedule);
        const { claudeArgs } = buildScheduleCommand(sessionId, schedule);

        runningTasks.add(taskKey);
        runCommand(claudeArgs, schedule.projectPath, schedule.name, () => {
          runningTasks.delete(taskKey);
        });
      } catch (err) {
        log.error(`[schedule] Failed to run ${schedule.name}:`, err);
      }
    }
  }

  // The first tick is aligned to the next minute boundary; the interval it
  // starts is held separately so stop() can clear whichever one is pending.
  let interval: NodeJS.Timeout | null = null;
  const msUntilNextMinute = (60 - new Date().getSeconds()) * 1000;
  const initialTimer = setTimeout(() => {
    tick();
    interval = setInterval(tick, 60 * 1000);
  }, msUntilNextMinute);

  return function stop() {
    running = false;
    clearTimeout(initialTimer);
    if (interval) clearInterval(interval);
  };
}
