/**
 * Building the world the app under test sees: a home folder, a data folder and
 * the fake CLIs, all under one temporary directory.
 *
 * Nothing here needs a seam in the app. Transcripts are found through
 * `os.homedir()` (src/infrastructure/fs/claude-paths.ts), so pointing HOME at
 * the fixture is enough; the database lives under SWITCHBOARD_DATA_DIR; and
 * sessions are started through the user's login shell, whose profile in the
 * fixture home puts the fake `claude` and `ssh` first on PATH.
 *
 * Everything is built in code from a `FixtureSpec`, with times stated relative
 * to `FIXTURE_NOW`, rather than committed as JSONL: a fixture is then readable
 * in a diff and a new session is one object literal. The renderer's clock is
 * frozen at `FIXTURE_NOW` by the launcher, so "20m ago" stays "20m ago"
 * whenever the suite runs.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electronPath from 'electron';
import { stableUuid, transcriptLines } from './transcript';
import type { FixturePullRequest } from './transcript';

/**
 * The moment every fixture is built around, and what the renderer's clock reads.
 *
 * A Wednesday afternoon in UTC (the launcher sets TZ=UTC), so "today", the
 * hour Patch dresses for and the weekday never depend on when or where the
 * suite runs.
 */
export const FIXTURE_NOW = Date.parse('2026-06-10T14:00:00.000Z');

export const minutesAgo = (n: number): number => FIXTURE_NOW - n * 60_000;
export const hoursAgo = (n: number): number => minutesAgo(n * 60);
export const daysAgo = (n: number): number => hoursAgo(n * 24);

/** A session id that is the same on every run, derived from a readable name. */
export const sessionId = (name: string): string => stableUuid('session', name);

export interface FixtureSession {
  /** Stable id; use `sessionId('some-name')`. */
  id: string;
  /** The first user message, which is the row's label. */
  prompt: string;
  /** Epoch ms of the last message: what the row's time label and sort use. */
  at: number;
  /** Epoch ms of the first message. Defaults to 10 minutes before `at`. */
  startedAt?: number;
  /** User and assistant entries; the row shows "· N msgs". Defaults to 4. */
  messages?: number;
  /** Sessions sharing a slug within one project fold into a slug group. */
  slug?: string;
  aiTitle?: string;
  customTitle?: string;
  /** A Switchboard rename (stored in the database, not the transcript). */
  name?: string;
  pinned?: boolean;
  archived?: boolean;
  pullRequests?: readonly FixturePullRequest[];
  /**
   * The directory the session ran in, relative to the home folder, when it is
   * not the project's own — a worktree, say. The transcript lands in the
   * folder this path encodes to, as the CLI would put it.
   */
  cwd?: string;
  forkedFrom?: string;
}

export interface FixtureProject {
  /** Relative to the home folder, e.g. `Development/acme-api`. */
  path: string;
  sessions: readonly FixtureSession[];
  /**
   * Create the directory on disk (default true). A project whose directory is
   * gone still lists — its transcripts remain — but cannot launch.
   */
  exists?: boolean;
}

export interface FixtureRemoteSession {
  id: string;
  kind?: 'claude' | 'shell';
  created: number;
  lastOpened?: number;
  name?: string;
  pinned?: boolean;
  archived?: boolean;
}

export interface FixtureRemote {
  user: string;
  host: string;
  port?: number;
  dir?: string;
  sessions?: readonly FixtureRemoteSession[];
}

export interface FixtureSpec {
  projects?: readonly FixtureProject[];
  remotes?: readonly FixtureRemote[];
  /** Merged over the harness defaults into the `global` settings blob. */
  settings?: Record<string, unknown>;
  /** Per-project overrides, keyed by the project path relative to home. */
  projectSettings?: Record<string, Record<string, unknown>>;
}

/** What a built fixture tells the rest of the harness. */
export interface FixtureHome {
  /** The temporary directory everything lives in; removed by `dispose`. */
  readonly root: string;
  /** HOME for the app and every process it starts. */
  readonly home: string;
  /** SWITCHBOARD_DATA_DIR. */
  readonly dataDir: string;
  /** Where the fake CLIs keep their per-session control files. */
  readonly controlDir: string;
  /** The directory the shell profile puts first on PATH. */
  readonly binDir: string;
  readonly spec: FixtureSpec;
  /** An absolute project path, from one relative to home. */
  projectPath(relative: string): string;
  dispose(): void;
}

/**
 * Settings every fixture starts from.
 *
 * - The window geometry is fixed, so screenshots have one size.
 * - Weather is off: it is a network fetch, and the sky it returns changes the
 *   empty screen.
 * - The appearance is pinned rather than following the host's system setting.
 */
export const HARNESS_SETTINGS: Readonly<Record<string, unknown>> = {
  appearance: 'light',
  weatherEnabled: false,
  windowBounds: { width: 1280, height: 800 },
};

/** Build a fixture home. Synchronous, and fast enough to run per test. */
export function fixtureHome(spec: FixtureSpec = {}): FixtureHome {
  // realpath: on macOS the temp dir is reached through the /var → /private/var
  // symlink, and a child's process.cwd() reports the resolved form. Every path
  // the app compares (a session's cwd against its project folder) has to agree.
  const root = fs.realpathSync(makeRoot());
  const home = path.join(root, 'home');
  const dataDir = path.join(root, 'data');
  const controlDir = path.join(root, 'control');
  const binDir = path.join(root, 'bin');
  for (const dir of [home, dataDir, controlDir, binDir]) fs.mkdirSync(dir, { recursive: true });

  const projectPath = (relative: string): string => path.join(home, relative);

  writeFakeBinaries(binDir, controlDir);
  writeShellProfiles(home, binDir);
  writeTranscripts(home, spec);
  seedDatabase(dataDir, root, spec, projectPath);

  return {
    root, home, dataDir, controlDir, binDir, spec, projectPath,
    dispose: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * A fresh, empty directory for one fixture, named with digits only.
 *
 * Not `mkdtemp`: its random suffix is letters too, and every project path
 * under the fixture carries it. The project picker matches a query against the
 * whole path as well as the label, so a suffix that happened to spell out the
 * query (an "api" across "sb-e2e-zpIbS9" and the temp dir above it) made an
 * unrelated project match, about one run in seventy.
 */
function makeRoot(): string {
  for (;;) {
    const name = 'sb-e2e-' + process.pid + '-' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
    const dir = path.join(os.tmpdir(), name);
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      return dir;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}

// ── Fake CLIs ──

const FAKE_CLI = path.join(__dirname, '..', 'fakes', 'fake-cli.mjs');

/**
 * `claude` and `ssh` wrappers that exec the fake with its role.
 *
 * The Node binary is baked in by absolute path: the session's PATH is whatever
 * the login shell made of it, and a fake that depended on finding `node` there
 * would break on a machine whose Node comes from a version manager.
 */
function writeFakeBinaries(binDir: string, controlDir: string): void {
  for (const role of ['claude', 'ssh']) {
    const file = path.join(binDir, role);
    fs.writeFileSync(file, [
      '#!/bin/sh',
      `exec ${sh(process.execPath)} ${sh(FAKE_CLI)} ${role} ${sh(controlDir)} "$@"`,
      '',
    ].join('\n'));
    fs.chmodSync(file, 0o755);
  }
}

/**
 * Shell profiles that put the fakes first on PATH.
 *
 * Sessions run as `<shell> -l -i -c 'claude …'` (src/domain/shell/quoting.ts),
 * so the PATH that counts is the one after every startup file has run. On macOS
 * /etc/zprofile runs path_helper, which moves the system directories ahead of
 * anything inherited or set in ~/.zshenv — so the prepend goes in the files
 * read last: ~/.zshrc for zsh, ~/.bashrc (sourced from ~/.bash_profile) for
 * bash, ~/.profile for sh. They print nothing: for a remote session any output
 * before ssh starts would read as the far end answering.
 */
function writeShellProfiles(home: string, binDir: string): void {
  const prepend = `export PATH=${sh(binDir)}:"$PATH"\n`;
  fs.writeFileSync(path.join(home, '.zshrc'), prepend);
  fs.writeFileSync(path.join(home, '.bashrc'), prepend);
  fs.writeFileSync(path.join(home, '.bash_profile'), '[ -f ~/.bashrc ] && . ~/.bashrc\n');
  fs.writeFileSync(path.join(home, '.profile'), prepend);
}

// ── Transcripts ──

function writeTranscripts(home: string, spec: FixtureSpec): void {
  const projectsDir = path.join(home, '.claude', 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });

  for (const project of spec.projects ?? []) {
    const projectDir = path.join(home, project.path);
    if (project.exists !== false) fs.mkdirSync(projectDir, { recursive: true });

    for (const session of project.sessions) {
      const cwd = session.cwd ? path.join(home, session.cwd) : projectDir;
      if (session.cwd && project.exists !== false) fs.mkdirSync(cwd, { recursive: true });

      const folder = path.join(projectsDir, encodeProjectPath(cwd));
      fs.mkdirSync(folder, { recursive: true });
      const lines = transcriptLines({
        sessionId: session.id,
        cwd,
        prompt: session.prompt,
        startedAt: session.startedAt ?? session.at - 10 * 60_000,
        endedAt: session.at,
        messages: session.messages ?? 4,
        slug: session.slug,
        aiTitle: session.aiTitle,
        customTitle: session.customTitle,
        pullRequests: session.pullRequests,
        forkedFrom: session.forkedFrom,
      });
      fs.writeFileSync(
        path.join(folder, session.id + '.jsonl'),
        lines.map(line => JSON.stringify(line)).join('\n') + '\n');
    }
  }
}

/**
 * The CLI's folder naming, for the short paths fixtures use.
 *
 * The app's own `encodeProjectPath` adds a hash suffix past 200 characters;
 * fixture paths never get near that, and importing the app's domain module
 * here would tie the harness to its file layout.
 */
export function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

// ── Database ──

interface SeedFile {
  settings: Record<string, unknown>;
  meta: { sessionId: string; name?: string; starred?: boolean; archived?: boolean }[];
}

function seedDatabase(
  dataDir: string,
  root: string,
  spec: FixtureSpec,
  projectPath: (relative: string) => string,
): void {
  const seed: SeedFile = { settings: {}, meta: [] };

  const remoteProjects = (spec.remotes ?? []).map(remote => ({
    user: remote.user,
    host: remote.host,
    port: remote.port ?? 22,
    dir: remote.dir ?? null,
    sessions: (remote.sessions ?? []).map(session => ({
      sessionId: session.id,
      kind: session.kind ?? 'claude',
      created: new Date(session.created).toISOString(),
      lastOpened: new Date(session.lastOpened ?? session.created).toISOString(),
    })),
  }));

  seed.settings.global = {
    ...HARNESS_SETTINGS,
    ...(remoteProjects.length ? { remoteProjects } : {}),
    ...spec.settings,
  };
  for (const [relative, settings] of Object.entries(spec.projectSettings ?? {})) {
    seed.settings['project:' + projectPath(relative)] = settings;
  }

  const sessions = [
    ...(spec.projects ?? []).flatMap(project => project.sessions),
    ...(spec.remotes ?? []).flatMap(remote => remote.sessions ?? []),
  ];
  for (const session of sessions) {
    if (!session.name && !session.pinned && !session.archived) continue;
    seed.meta.push({
      sessionId: session.id,
      name: session.name,
      starred: session.pinned,
      archived: session.archived,
    });
  }

  const seedPath = path.join(root, 'seed.json');
  fs.writeFileSync(seedPath, JSON.stringify(seed, null, 2));

  const result = spawnSync(electronBinary(), [path.join(__dirname, 'seed-db.cjs'), seedPath], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`seeding the fixture database failed (did you run \`npm run build\`?):\n${result.stderr}`);
  }
}

/** Under plain Node, `require('electron')` is the path to the binary. */
export function electronBinary(): string {
  return electronPath as unknown as string;
}

function sh(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
