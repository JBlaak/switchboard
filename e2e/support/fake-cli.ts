/**
 * Driving the fake `claude` and `ssh` from a test.
 *
 * The fake (e2e/fakes/fake-cli.mjs) reads commands from a file in its control
 * directory and acknowledges each one once its output is on the PTY. Every
 * method here appends a command and waits for that acknowledgement, so a test
 * reads as a script — `await claude.busy(); await expect(row).toHaveClass(…)` —
 * with no sleeps in it. What the app makes of the output is still asynchronous
 * (it crosses IPC to the renderer), which is what the `expect` polling is for.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FixtureHome } from './fixture-home';

/** What the fake recorded about one launch. */
export interface FakeLaunch {
  role: 'claude' | 'ssh';
  key: string;
  argv: string[];
  cwd: string;
  pid: number;
  home: string;
  startedAt: number;
  /** claude only: the id from `--session-id` or `--resume`. */
  sessionId?: string;
  /** claude only: true for `--resume`. */
  resume?: boolean;
  /** claude only: the parsed `--settings` JSON — the question hook. */
  settings?: QuestionHookSettings | null;
}

/** The part of `--settings` the question hook lives in. */
export interface QuestionHookSettings {
  hooks?: {
    PreToolUse?: { matcher: string; hooks: { type: string; url: string; headers: Record<string, string> }[] }[];
  };
}

/** One OSC 7501 report, before encoding. */
export interface ProgramStatus {
  state: 'idle' | 'working' | 'done' | 'blocked' | 'error' | 'clear';
  /** What a `blocked` state is blocked on. */
  kind?: 'permission' | 'question' | 'auth';
  /** A child record (subagent) path; omit for the session itself. */
  id?: string;
  progress?: number;
  title?: string;
  msg?: string;
}

const POLL_MS = 25;
const DEFAULT_TIMEOUT_MS = 10_000;

export class FakeCli {
  readonly dir: string;

  constructor(controlDir: string, readonly key: string) {
    this.dir = path.join(controlDir, key);
  }

  /** The current launch, once the process has started. */
  async launched(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<FakeLaunch> {
    const file = path.join(this.dir, 'launch.json');
    await waitFor(() => fs.existsSync(file), timeoutMs, `${this.key} to launch`);
    return JSON.parse(fs.readFileSync(file, 'utf8')) as FakeLaunch;
  }

  /** Every launch so far, oldest first: a resume or a reconnect adds one. */
  launches(): FakeLaunch[] {
    return readJsonLines<FakeLaunch>(path.join(this.dir, 'launches.jsonl'));
  }

  /** Wait until the process has been started `count` times in all. */
  async waitForLaunchCount(count: number, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<FakeLaunch> {
    await waitFor(() => this.launches().length >= count, timeoutMs, `${this.key} to launch ${count} times`);
    return this.launches()[count - 1];
  }

  /** Everything typed into the session's terminal so far. */
  input(): string {
    try {
      return fs.readFileSync(path.join(this.dir, 'input.log'), 'utf8');
    } catch {
      return '';
    }
  }

  /** The PTY's current size, as the process last saw it. */
  size(): { cols: number; rows: number } | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, 'size.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  async waitForInput(text: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
    await waitFor(() => this.input().includes(text), timeoutMs, `${JSON.stringify(text)} to reach ${this.key}`);
  }

  /** Append a raw command and wait for the fake to carry it out. */
  async send(command: { op: string; [key: string]: unknown }, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
    await this.launched(timeoutMs);
    const seq = crypto.randomUUID();
    fs.appendFileSync(path.join(this.dir, 'commands.jsonl'), JSON.stringify({ ...command, seq }) + '\n');
    const acks = path.join(this.dir, 'acks.jsonl');
    await waitFor(
      () => readJsonLines<{ seq: string }>(acks).some(a => a.seq === seq),
      timeoutMs, `${this.key} to run ${command.op}`);
  }

  /** Raw output. Lines end in `\r\n` on a terminal. */
  print(text: string): Promise<void> {
    return this.send({ op: 'print', text });
  }

  /** Print lines, each terminated with `\r\n`. */
  println(...lines: string[]): Promise<void> {
    return this.print(lines.map(line => line + '\r\n').join(''));
  }

  /** OSC 0: the window title. */
  title(text: string): Promise<void> {
    return this.send({ op: 'title', text });
  }

  /** OSC 0 with a spinner frame: the legacy "turn in flight" signal. */
  busy(text?: string): Promise<void> {
    return this.send({ op: 'busy', text });
  }

  /** OSC 0 with the `✳` glyph: the legacy "waiting for you" signal. */
  idle(text?: string): Promise<void> {
    return this.send({ op: 'idle', text });
  }

  /** OSC 7501: the Program Status Protocol, which overrides titles once spoken. */
  status(report: ProgramStatus): Promise<void> {
    return this.send({ op: 'status', ...report });
  }

  /** OSC 9: an iTerm2-style notification, which marks the row as needing input. */
  notify(message: string): Promise<void> {
    return this.send({ op: 'notify', message });
  }

  /** OSC 777 `notify` — the rxvt/Ghostty form; Switchboard does not read it today. */
  notify777(title: string, body: string): Promise<void> {
    return this.send({ op: 'notify777', title, body });
  }

  /** OSC 9;4 progress: level 0 clear, 1 running, 2 error, 3 indeterminate. */
  progress(level: 0 | 1 | 2 | 3, percent?: number): Promise<void> {
    return this.send({ op: 'progress', level, percent });
  }

  bell(): Promise<void> {
    return this.send({ op: 'bell' });
  }

  /**
   * Append lines to this session's transcript, as the CLI does after each
   * turn. Missing `sessionId`, `cwd`, `uuid` and `timestamp` are filled in
   * (the timestamp with the real time, which the frozen renderer clock reads
   * as "just now").
   */
  transcript(...entries: Record<string, unknown>[]): Promise<void> {
    return this.send({ op: 'transcript', entries });
  }

  /** A user turn in the transcript — what turns a pending row into a real one. */
  userTurn(content: string): Promise<void> {
    return this.transcript({ type: 'user', message: { role: 'user', content } });
  }

  /** Start a new transcript that names this session as its origin: a fork. */
  fork(newSessionId: string, prompt?: string): Promise<void> {
    return this.send({ op: 'fork', newSessionId, prompt });
  }

  /** Exit with this code once everything before it has been written. */
  exit(code = 0): Promise<void> {
    return this.send({ op: 'exit', code });
  }
}

/** The fake `claude` a session id launches. */
export function fakeClaude(home: FixtureHome, sessionId: string): FakeCli {
  return new FakeCli(home.controlDir, sessionId);
}

/**
 * The fake `ssh` a remote session dials.
 *
 * Keyed by the tmux session name the app derives from the session id
 * (`tmuxSessionName` in src/domain/project/remote-target.ts), because that is
 * all the ssh command line carries. The fake is silent until told otherwise,
 * so a freshly opened remote session sits in the "connecting" phase; `print`
 * anything to connect, `exit(255)` to drop the link, or print an
 * authentication failure and exit to make it give up.
 */
export function fakeSsh(home: FixtureHome, sessionId: string): FakeCli {
  return new FakeCli(home.controlDir, 'sb-' + sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8));
}

/** The keys of every fake that has launched so far. */
export function launchedKeys(home: FixtureHome): Set<string> {
  return new Set(fs.readdirSync(home.controlDir)
    .filter(key => fs.existsSync(path.join(home.controlDir, key, 'launch.json'))));
}

/**
 * Wait for a fake to launch under a key that is not in `before`.
 *
 * For sessions whose id the test cannot know in advance — one started from
 * the project picker gets a fresh random id. Take `launchedKeys` before the
 * click, then call this.
 */
export async function waitForNewLaunch(
  home: FixtureHome, role: 'claude' | 'ssh', before: Set<string>, timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<FakeCli> {
  let found: string | undefined;
  await waitFor(() => {
    found = [...launchedKeys(home)].find(key => !before.has(key)
      && (JSON.parse(fs.readFileSync(path.join(home.controlDir, key, 'launch.json'), 'utf8')) as FakeLaunch).role === role);
    return !!found;
  }, timeoutMs, `a new ${role} to launch`);
  return new FakeCli(home.controlDir, found!);
}

export async function waitFor(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

function readJsonLines<T>(file: string): T[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as T);
}
