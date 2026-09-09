/**
 * Scheduled tasks: a markdown file with a cron expression in its frontmatter.
 *
 * A schedule lives in the project's own `.claude/commands/` directory, so the
 * same file is both what Switchboard runs on a timer and a slash command the
 * user can invoke by hand. Each run resumes a freshly seeded session, which is
 * what groups the runs under one slug in the sidebar.
 */
import { block, parseFrontmatter, scalar } from './frontmatter';

/** The `cli:` block of a schedule's frontmatter — flags passed through to claude. */
export type ScheduleCli = Record<string, string>;

/** A `schedule-*.md` file, parsed. */
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

/** Where a schedule file must live, relative to the project root. */
export const SCHEDULE_COMMANDS_SUBPATH = ['.claude', 'commands'];

/** Only files named this way are picked up as schedules. */
export function isScheduleFileName(name: string): boolean {
  return name.startsWith('schedule-') && name.endsWith('.md');
}

/** The slug a schedule file defaults to, from its own name. */
export function defaultScheduleSlug(fileName: string): string {
  return fileName.replace(/^schedule-/, '').replace(/\.md$/, '');
}

/** Where a schedule's identity comes from, beyond its own content. */
export interface ScheduleLocation {
  file: string;
  filePath: string;
  projectPath: string;
  folder: string;
}

/**
 * Parse a schedule file, or null when it is not a runnable schedule.
 *
 * A file with no cron, no body, or `enabled: false` is skipped rather than
 * reported: the first two mean it is still being written and the third is how
 * the user turns one off.
 */
export function parseSchedule(content: string, location: ScheduleLocation): Schedule | null {
  const { meta, body } = parseFrontmatter(content);
  const cron = typeof meta.cron === 'string' ? meta.cron : null;
  if (!cron || !body) return null;
  if (meta.enabled === 'false') return null;

  return {
    ...location,
    name: scalar(meta, 'name', location.file),
    cron,
    slug: scalar(meta, 'slug', defaultScheduleSlug(location.file)),
    cli: block(meta, 'cli'),
    prompt: body,
  };
}

/**
 * Parse a schedule file for an immediate manual run.
 *
 * Unlike `parseSchedule` this ignores `enabled` and does not need a cron — the
 * user clicked Run, which is the trigger — but it still needs a prompt.
 */
export function parseScheduleForManualRun(content: string, location: ScheduleLocation): Schedule | null {
  const { meta, body } = parseFrontmatter(content);
  if (!body) return null;
  return {
    ...location,
    name: scalar(meta, 'name', location.file),
    cron: scalar(meta, 'cron', '* * * * *'),
    slug: scalar(meta, 'slug', defaultScheduleSlug(location.file)),
    cli: block(meta, 'cli'),
    prompt: body,
  };
}

/** The re-entrancy key: one run of a given task at a time. */
export function scheduleTaskKey(schedule: Pick<Schedule, 'folder' | 'slug'>): string {
  return `${schedule.folder}:${schedule.slug}`;
}

/** Raised when a frontmatter value cannot be passed to the CLI safely. */
export class UnsafeScheduleFieldError extends Error {}

/**
 * Defence in depth: reject control characters in frontmatter values.
 *
 * The shell quoter is the real defence — these values go into an argv that is
 * quoted before it reaches a shell — but a schedule file is the one input to
 * this app that another Claude session writes, so a value that could not
 * possibly be legitimate is refused rather than escaped.
 */
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

function assertSafe(field: string, value: string): string {
  if (CONTROL_CHARS.test(value)) {
    throw new UnsafeScheduleFieldError(`Schedule field "${field}" contains unsafe characters`);
  }
  return value;
}

const DEFAULT_ALLOWED_TOOLS = 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch';

/**
 * The `claude` argv for one scheduled run.
 *
 * A plain argv with zero shell interpretation — the caller shell-quotes it when
 * building the command string.
 */
export function buildScheduleArgs(sessionId: string, schedule: Pick<Schedule, 'cli'>): string[] {
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
      throw new UnsafeScheduleFieldError(
        `Schedule field "max-budget-usd" must be a number, got: ${cli['max-budget-usd']}`);
    }
    args.push('--max-budget-usd', budget);
  }

  args.push('--allowedTools', assertSafe('allowed-tools', cli['allowed-tools'] || DEFAULT_ALLOWED_TOOLS));

  if (cli['append-system-prompt']) {
    // Newlines are legitimate in prompt text; other control characters are not.
    const prompt = String(cli['append-system-prompt']);
    if (CONTROL_CHARS.test(prompt)) {
      throw new UnsafeScheduleFieldError('Schedule field "append-system-prompt" contains unsafe characters');
    }
    args.push('--append-system-prompt', prompt);
  }

  if (cli['add-dirs']) {
    for (const dir of String(cli['add-dirs']).split(',').map(d => d.trim()).filter(Boolean)) {
      args.push('--add-dir', assertSafe('add-dirs', dir));
    }
  }

  return args;
}
