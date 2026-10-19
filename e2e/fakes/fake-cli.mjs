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
 * - `size.json` — `{ cols, rows }`, rewritten whenever the PTY is resized.
 *
 * The command vocabulary is documented on `run` below and mirrored by the
 * typed controller in e2e/support/fake-cli.ts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [, , role, controlDir, ...argv] = process.argv;

// A routing call (`-p` with no session to resume) answers once and exits; it
// has no PTY and no control directory of its own.
if (role === 'claude' && argv.includes('-p') && !argv.includes('--resume')) await answerRoute();

/** How often the command file is polled. Short: tests wait on every ack. */
const POLL_MS = 25;

const key = role === 'ssh' ? sshKey(argv) : claudeKey(argv);
const dir = path.join(controlDir, key);
fs.mkdirSync(dir, { recursive: true });

const commandsPath = path.join(dir, 'commands.jsonl');
const acksPath = path.join(dir, 'acks.jsonl');
const inputPath = path.join(dir, 'input.log');
const sizePath = path.join(dir, 'size.json');

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
// Written aside and renamed into place: the test polls for the file and would
// otherwise read it half-written.
fs.writeFileSync(path.join(dir, 'launch.json.tmp'), JSON.stringify(launch, null, 2));
fs.renameSync(path.join(dir, 'launch.json.tmp'), path.join(dir, 'launch.json'));
fs.appendFileSync(path.join(dir, 'launches.jsonl'), JSON.stringify(launch) + '\n');

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('data', (chunk) => fs.appendFileSync(inputPath, chunk));
// The PTY closing under us (the session was stopped) is the normal way out.
process.stdin.on('end', () => process.exit(0));
process.on('SIGHUP', () => process.exit(129));
process.on('SIGTERM', () => process.exit(143));

if (role === 'claude') greet();

// The PTY's size, kept current, so a test can see the app refit the terminal
// (a font change, a panel that covered it) without reading the canvas.
writeSize();
process.stdout.on('resize', writeSize);

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

function writeSize() {
  const size = { cols: process.stdout.columns, rows: process.stdout.rows };
  fs.writeFileSync(sizePath + '.tmp', JSON.stringify(size));
  fs.renameSync(sizePath + '.tmp', sizePath);
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

// ── Routing calls ──

/**
 * Ask Patch's routing call (#135): record the argv and the prompt in
 * `route/calls.jsonl` and print what the test put in `route/answer.json` —
 * `{ stdout, exitCode?, delayMs? }` — or, with no answer set, a CLI error. The
 * delay is what lets a test see the wait and cancel it.
 *
 * A warm call (`--input-format stream-json`, S2) is started before the
 * request and waits for its prompt on stdin, as one user message line. Only
 * then is the call recorded and the answer read; it is printed after an
 * `init` event, and the process exits once stdin closes. One that is killed
 * or closed before a message arrives records nothing.
 *
 * Quick Ask's capture and undo calls (#151) are allowed one tool; when the
 * test set `route/answer-<tool>.json`, that call prints it instead. A call
 * given `--mcp-config` records the file's mode and its servers' names, read
 * while the call runs, and never what is in them.
 */
async function answerRoute() {
  const dir = path.join(controlDir, 'route');
  fs.mkdirSync(dir, { recursive: true });
  process.on('SIGTERM', () => process.exit(143));
  const warm = argv.includes('--input-format') && argv[argv.indexOf('--input-format') + 1] === 'stream-json';
  const prompt = warm ? await userMessage() : argv.at(-1);
  if (prompt === null) process.exit(0);

  const mcpConfig = flagValue('--mcp-config');
  const mcp = mcpConfig === null ? undefined : mcpFacts(mcpConfig);
  fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ argv, cwd: process.cwd(), prompt, warm, mcp }) + '\n');
  const tool = flagValue('--allowedTools');
  const toolAnswer = tool === null ? null : path.join(dir, `answer-${tool}.json`);
  let answer = { stdout: '', exitCode: 1 };
  try {
    answer = JSON.parse(fs.readFileSync(toolAnswer && fs.existsSync(toolAnswer) ? toolAnswer : path.join(dir, 'answer.json'), 'utf8'));
  } catch {
    // No answer set: fail the way a real CLI with no answer would.
  }
  setTimeout(() => {
    if (!warm) {
      process.stdout.write(answer.stdout ?? '', () => process.exit(answer.exitCode ?? 0));
      return;
    }
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\n' + (answer.stdout ?? ''));
    process.stdin.on('end', () => process.exit(0));
    process.stdin.resume();
  }, answer.delayMs ?? 0);
  // Never settles, so the module stops here: the process ends from the timer above.
  await new Promise(() => {});
}

function flagValue(name) {
  const i = argv.indexOf(name);
  return i < 0 ? null : argv[i + 1] ?? null;
}

/** An MCP config's path, mode and server names. */
function mcpFacts(file) {
  try {
    const servers = Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers ?? {});
    return { path: file, mode: fs.statSync(file).mode & 0o777, servers };
  } catch {
    return { path: file, mode: null, servers: [] };
  }
}

/** The content of the first user message on stdin, or null when stdin closes first. */
function userMessage() {
  return new Promise((resolve) => {
    let buffered = '';
    const onData = (chunk) => {
      buffered += chunk.toString();
      const end = buffered.indexOf('\n');
      if (end < 0) return;
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.pause();
      resolve(JSON.parse(buffered.slice(0, end)).message.content);
    };
    const onEnd = () => resolve(null);
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
  });
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
