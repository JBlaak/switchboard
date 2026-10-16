/**
 * A stand-in for `claude` and `ssh`, driven by the test that launched the app.
 *
 * Switchboard starts every session through the user's login shell, so the
 * fixture home's shell profile puts a directory of wrappers first on PATH and
 * each wrapper execs this script with the role it plays (see
 * e2e/support/fixture-home.ts). Nothing in the app knows it is not talking to
 * the real CLI: it sees the same argv, the same PTY, the same escape sequences
 * and the same transcript writes.
 *
 * Plain JavaScript, run by the Node that runs Playwright, so it needs no build
 * step and starts in a few tens of milliseconds.
 *
 * ## The control directory
 *
 * Each process owns `<control>/<key>/`, where the key is the session id for
 * `claude` (from `--session-id` or `--resume`) and the tmux session name
 * (`sb-xxxxxxxx`) for `ssh`:
 *
 * - `launch.json` — argv, cwd, pid, role; rewritten on every launch, and
 *   `launches.jsonl` keeps one line per launch so a test can count respawns.
 * - `commands.jsonl` — the test appends one JSON command per line. A process
 *   only reads lines written after it started, so a relaunch never replays the
 *   previous run's script.
 * - `acks.jsonl` — `{ seq }` per command once its effect has been written to
 *   the PTY, which is what lets a test wait for a command instead of sleeping.
 * - `input.log` — every byte the PTY delivered on stdin, so a test can check
 *   that typing in the terminal reached the process.
 *
 * The command vocabulary is documented on `run` below and mirrored by the
 * typed controller in e2e/support/fake-cli.ts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [, , role, controlDir, ...argv] = process.argv;

/** How often the command file is polled. Short: tests wait on every ack. */
const POLL_MS = 25;

const key = role === 'ssh' ? sshKey(argv) : claudeKey(argv);
const dir = path.join(controlDir, key);
fs.mkdirSync(dir, { recursive: true });

const commandsPath = path.join(dir, 'commands.jsonl');
const acksPath = path.join(dir, 'acks.jsonl');
const inputPath = path.join(dir, 'input.log');

// Measured before launch.json exists: the test waits for launch.json and only
// then writes commands, so everything it sends lands after this offset.
let offset = fileSize(commandsPath);
let pending = '';

const launch = {
  role,
  key,
  argv,
  cwd: process.cwd(),
  pid: process.pid,
  home: os.homedir(),
  startedAt: Date.now(),
  ...(role === 'claude' ? claudeLaunchFacts(argv) : {}),
};
fs.writeFileSync(path.join(dir, 'launch.json'), JSON.stringify(launch, null, 2));
fs.appendFileSync(path.join(dir, 'launches.jsonl'), JSON.stringify(launch) + '\n');

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('data', (chunk) => fs.appendFileSync(inputPath, chunk));
// The PTY closing under us (the session was stopped) is the normal way out.
process.stdin.on('end', () => process.exit(0));
process.on('SIGHUP', () => process.exit(129));
process.on('SIGTERM', () => process.exit(143));

if (role === 'claude') greet();

setInterval(poll, POLL_MS);

// ── Startup ──

/**
 * What the fake prints on its own before any command: a fixed title and one
 * line, so a screenshot of a freshly opened session is stable. `ssh` prints
 * nothing — a real one is silent until the far end answers, and output is what
 * ends the app's "connecting" state.
 */
function greet() {
  const mode = launch.resume ? 'Resumed' : 'Started';
  write(osc(0, '✳ Claude Code'));
  write(`Fake Claude · ${mode} session ${launch.sessionId}\r\n`);
}

// ── Commands ──

function poll() {
  const size = fileSize(commandsPath);
  if (size <= offset) return;
  const fd = fs.openSync(commandsPath, 'r');
  const buffer = Buffer.alloc(size - offset);
  fs.readSync(fd, buffer, 0, buffer.length, offset);
  fs.closeSync(fd);
  offset = size;

  pending += buffer.toString('utf8');
  const lines = pending.split('\n');
  pending = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    run(command);
    if (command.op !== 'exit') ack(command.seq);
  }
}

/**
 * Carry out one command.
 *
 * - `print { text }` — raw output; include `\r\n` yourself.
 * - `title { text }` — OSC 0, the window title the header shows.
 * - `busy { text? }` / `idle { text? }` — an OSC 0 title with the CLI's
 *   spinner frame or its `✳` idle glyph: the legacy busy signal.
 * - `status { state, kind?, id?, progress?, title?, msg? }` — OSC 7501, the
 *   Program Status Protocol; `title` and `msg` are base64-encoded here.
 * - `notify { message }` — OSC 9, an iTerm2-style notification.
 * - `notify777 { title, body }` — OSC 777 `notify`, the rxvt/Ghostty form.
 * - `progress { level, percent? }` — OSC 9;4.
 * - `bell` — a standalone BEL.
 * - `transcript { entries }` — append lines to this session's transcript,
 *   filling in sessionId, cwd and timestamp where an entry leaves them out.
 * - `fork { newSessionId, prompt? }` — start a new transcript that names this
 *   session in `forkedFrom`, the way `--fork-session` does.
 * - `exit { code }` — acknowledge, then exit with that code.
 */
function run(command) {
  switch (command.op) {
    case 'print':
      write(command.text);
      break;
    case 'title':
      write(osc(0, command.text));
      break;
    case 'busy':
      write(osc(0, '⠋ ' + (command.text ?? 'Working')));
      break;
    case 'idle':
      write(osc(0, '✳ ' + (command.text ?? 'Claude Code')));
      break;
    case 'status':
      write(osc(7501, programStatus(command)));
      break;
    case 'notify':
      write(osc(9, command.message));
      break;
    case 'notify777':
      write(osc(777, `notify;${command.title};${command.body}`));
      break;
    case 'progress':
      write(osc(9, `4;${command.level};${command.percent ?? ''}`));
      break;
    case 'bell':
      write('\x07');
      break;
    case 'transcript':
      appendTranscript(launch.sessionId, command.entries);
      break;
    case 'fork':
      appendTranscript(command.newSessionId, [
        { type: 'user', forkedFrom: { sessionId: launch.sessionId, messageUuid: uuidLike() },
          message: { role: 'user', content: command.prompt ?? 'Forked conversation' } },
      ]);
      break;
    case 'exit':
      // Acknowledged first: once the process is gone nobody is left to say so.
      ack(command.seq);
      process.exitCode = command.code ?? 0;
      process.stdout.write('', () => process.exit(command.code ?? 0));
      break;
    default:
      write(`\r\n[fake-cli] unknown command ${JSON.stringify(command.op)}\r\n`);
  }
}

function programStatus({ state, kind, id, progress, title, msg }) {
  const pairs = [`state=${state}`];
  if (id) pairs.push(`id=${id}`);
  if (kind) pairs.push(`kind=${kind}`);
  if (progress !== undefined) pairs.push(`progress=${progress}`);
  if (title !== undefined) pairs.push(`title=${Buffer.from(title).toString('base64')}`);
  if (msg !== undefined) pairs.push(`msg=${Buffer.from(msg).toString('base64')}`);
  return pairs.join(':');
}

/**
 * Append to a transcript where the real CLI would: under the folder the
 * project's cwd encodes to. The encoding mirrors `encodeProjectPath` in
 * src/domain/project/project-path.ts for the short paths fixtures use.
 */
function appendTranscript(sessionId, entries) {
  const folder = path.join(os.homedir(), '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(folder, { recursive: true });
  const lines = entries.map((entry) => JSON.stringify({
    sessionId,
    cwd: process.cwd(),
    uuid: uuidLike(),
    timestamp: new Date().toISOString(),
    ...entry,
  }));
  fs.appendFileSync(path.join(folder, sessionId + '.jsonl'), lines.join('\n') + '\n');
}

// ── Argv ──

function claudeKey(args) {
  const facts = claudeLaunchFacts(args);
  return facts.sessionId ?? `claude-${process.pid}`;
}

/** What the app's `buildClaudeArgs` put on the command line. */
function claudeLaunchFacts(args) {
  const valueOf = (flag) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  const resume = valueOf('--resume');
  const settings = valueOf('--settings');
  return {
    sessionId: resume ?? valueOf('--session-id'),
    resume: resume !== undefined,
    settings: settings ? JSON.parse(settings) : null,
  };
}

/** The tmux session the remote command attaches to — one per Switchboard session. */
function sshKey(args) {
  const remoteCommand = args[args.length - 1] ?? '';
  const match = /tmux new-session -d -s (\S+)/.exec(remoteCommand);
  return match ? match[1] : `ssh-${process.pid}`;
}

// ── Helpers ──

function write(text) {
  process.stdout.write(text);
}

function osc(code, payload) {
  return `\x1b]${code};${payload}\x07`;
}

function ack(seq) {
  fs.appendFileSync(acksPath, JSON.stringify({ seq, pid: process.pid }) + '\n');
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function uuidLike() {
  return crypto.randomUUID();
}
