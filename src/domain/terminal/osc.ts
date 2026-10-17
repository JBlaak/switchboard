/**
 * What a PTY's byte stream says about the CLI running in it.
 *
 * Claude CLI narrates itself through terminal escape sequences meant for a
 * terminal emulator: the window title (OSC 0) carries a spinner while a turn is
 * in flight and a `✳` when it is waiting, OSC 9 carries iTerm2-style
 * notifications and progress, and the alternate-screen switch says a TUI has
 * taken over. Reading those is how a session's state reaches the sidebar without
 * asking the CLI anything.
 *
 * Newer CLIs (2.1.295+) also speak the Program Status Protocol, OSC 7501, which
 * states the session's state outright instead of leaving it to be inferred from
 * a title glyph. It is only spoken to a terminal that answers its probe, so the
 * probe and its reply live here too; see `PROGRAM_STATUS_REPLY`.
 *
 * Parsing is separated from the state it feeds so both can be tested against a
 * plain string.
 */

/** One thing a chunk of PTY output said. */
export type TerminalEvent =
  | { kind: 'title'; text: string }
  | { kind: 'progress'; level: string }
  | { kind: 'notification'; message: string }
  | ProgramStatusReport
  | { kind: 'program-status-query' }
  | { kind: 'alt-screen'; active: boolean }
  | { kind: 'bell' };

// ── Program Status Protocol (OSC 7501) ──

/** The states a 7501 report can carry. Anything else voids the report. */
export type ProgramStatusState = 'idle' | 'working' | 'done' | 'blocked' | 'error' | 'clear';

/** What a `blocked` report is blocked on. */
export type ProgramStatusBlock = 'permission' | 'question' | 'auth';

/**
 * One OSC 7501 report: the full state of one record, replacing what it said
 * before.
 *
 * A report without `id` is the root record — the program itself. One with an
 * `id` is a child (for Claude, a subagent), named by a slash path. `blockedOn`
 * is the protocol's `kind` key, renamed because `kind` is this union's
 * discriminant. `title` and `msg` arrive base64-encoded and are decoded here.
 */
export interface ProgramStatusReport {
  kind: 'program-status';
  state: ProgramStatusState;
  id?: string;
  blockedOn?: ProgramStatusBlock;
  /** 0–100. */
  progress?: number;
  app?: string;
  title?: string;
  msg?: string;
}

/**
 * What a terminal answers the CLI's `ESC ] 7501 ; ? ST` probe with.
 *
 * The CLI follows its probe with a primary-DA query (`CSI c`) and treats 7501
 * as unsupported if the DA answer — or two seconds — comes first. xterm.js in
 * the renderer does answer DA, but only after an IPC round trip, while this
 * reply is written straight back into the PTY by the main process the moment
 * the probe is seen, so it reliably wins.
 */
export const PROGRAM_STATUS_REPLY =
  '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\';

const PROGRAM_STATUS_STATES: ReadonlySet<string> =
  new Set<ProgramStatusState>(['idle', 'working', 'done', 'blocked', 'error', 'clear']);
const PROGRAM_STATUS_BLOCKS: ReadonlySet<string> =
  new Set<ProgramStatusBlock>(['permission', 'question', 'auth']);

/** C0, DEL and C1 — none belongs in a decoded title or message. */
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/;

/**
 * Base64 to UTF-8 text, or null when it is not valid as either.
 *
 * `atob` and `TextDecoder` are globals in both Electron's main process and
 * Node 22, which keeps the domain free of `node:` imports.
 */
function decodeBase64Text(encoded: string): string | null {
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Read one 7501 payload (`key=value:key=value`) into a report.
 *
 * Null when the report has to be ignored as a whole: no state, a state this
 * version does not know (the spec says to drop those rather than guess), or a
 * title or message that does not decode to clean text — a control character
 * there could only be an attempt to smuggle escape sequences into the UI.
 * A malformed pair or an unknown key on its own is skipped, not fatal: the
 * spec leaves room for keys to be added.
 */
export function parseProgramStatus(payload: string): ProgramStatusReport | null {
  const fields = new Map<string, string>();
  for (const pair of payload.split(':')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    fields.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }

  const state = fields.get('state');
  if (state === undefined || !PROGRAM_STATUS_STATES.has(state)) return null;
  const report: ProgramStatusReport = { kind: 'program-status', state: state as ProgramStatusState };

  const id = fields.get('id');
  if (id) report.id = id;

  const blockedOn = fields.get('kind');
  if (blockedOn !== undefined && PROGRAM_STATUS_BLOCKS.has(blockedOn)) {
    report.blockedOn = blockedOn as ProgramStatusBlock;
  }

  const progress = fields.get('progress');
  if (progress !== undefined && /^\d{1,3}$/.test(progress) && Number(progress) <= 100) {
    report.progress = Number(progress);
  }

  const app = fields.get('app');
  if (app) report.app = app;

  for (const key of ['title', 'msg'] as const) {
    const encoded = fields.get(key);
    if (encoded === undefined) continue;
    const text = decodeBase64Text(encoded);
    if (text === null || CONTROL_CHARS.test(text)) return null;
    report[key] = text;
  }

  return report;
}

// ── OSC 0 titles ──

/** How much of an OSC payload is kept — titles and messages are short. */
const PAYLOAD_LIMIT = 120;

/** Braille block: older CLIs' spinner frames all live in it. */
const SPINNER_FIRST = 0x2800;
const SPINNER_LAST = 0x28ff;
/** `◐ ◑ ◒ ◓` — the quarter-circle spinner CLI 2.1.301 switched to. */
const CIRCLE_SPINNER_FIRST = 0x25d0;
const CIRCLE_SPINNER_LAST = 0x25d3;
/** `✳` — the CLI's "waiting for you" glyph. */
const IDLE_GLYPH = '✳';

/**
 * Does this OSC 0 title mean a turn is in flight?
 *
 * Only a fallback now, for CLIs too old to speak 7501 and for remote sessions
 * where tmux answers the probe's DA query before we can. Newer CLIs leave the
 * last spinner frame in the title after a turn ends, so on them this says
 * "busy" long after the work stopped — which is why 7501 overrides it.
 */
export function titleMeansBusy(title: string): boolean {
  const code = title.charAt(0).charCodeAt(0);
  return (code >= SPINNER_FIRST && code <= SPINNER_LAST)
    || (code >= CIRCLE_SPINNER_FIRST && code <= CIRCLE_SPINNER_LAST);
}

/** Does this OSC 0 title mean the CLI is waiting for the user? */
export function titleMeansIdle(title: string): boolean {
  return title.charAt(0) === IDLE_GLYPH;
}

/**
 * Everything a chunk of output announced, in order.
 *
 * Cheap to call on every chunk: the sequence scans only run when the chunk
 * contains the escape byte that introduces them.
 */
export function parseTerminalEvents(data: string): TerminalEvent[] {
  const events: TerminalEvent[] = [];

  if (data.includes('\x1b]')) {
    // OSC <code>;<payload>, terminated by BEL or ST.
    //
    // Only whole sequences match: one split across two chunks is missed. For
    // the 7501 probe that costs the session its program status (it falls back
    // to titles), which is acceptable because the CLI writes the probe in one
    // small burst at startup and it arrives as a single chunk in practice.
    for (const m of data.matchAll(/\x1b\](\d+);([^\x07\x1b]*)(?:\x07|\x1b\\)/g)) {
      if (m[1] === '0') {
        events.push({ kind: 'title', text: m[2].slice(0, PAYLOAD_LIMIT) });
      } else if (m[1] === '7501') {
        if (m[2].trimStart().startsWith('?')) {
          events.push({ kind: 'program-status-query' });
        } else {
          const report = parseProgramStatus(m[2]);
          if (report) events.push(report);
        }
      }
    }
    for (const m of data.matchAll(/\x1b\]9;([^\x07\x1b]*)(?:\x07|\x1b\\)/g)) {
      const payload = m[1];
      // OSC 9;4 is progress: 4;0; = clear/done, 4;1;N = running at N%,
      // 4;2;N = error, 4;3; = indeterminate.
      if (payload.startsWith('4;')) {
        events.push({ kind: 'progress', level: payload.split(';')[1] ?? '' });
      } else {
        events.push({ kind: 'notification', message: payload });
      }
    }
  }

  // A standalone BEL, not the terminator of an OSC sequence.
  if (data.includes('\x07') && !data.includes('\x1b]')) events.push({ kind: 'bell' });

  if (data.includes('\x1b[?')) {
    if (data.includes('\x1b[?1049h') || data.includes('\x1b[?47h')) {
      events.push({ kind: 'alt-screen', active: true });
    }
    if (data.includes('\x1b[?1049l') || data.includes('\x1b[?47l')) {
      events.push({ kind: 'alt-screen', active: false });
    }
  }

  return events;
}

/**
 * Something the tracker decided the UI should hear about.
 *
 * `busy` is a working↔ready transition; `needs-attention` is the CLI blocking
 * on the user (a permission prompt, a question, a login).
 */
export type CliStateChange =
  | { kind: 'busy'; busy: boolean }
  | { kind: 'needs-attention' }
  /**
   * The CLI is at its prompt for the first time, without a turn before it: a
   * session that just started. Only said once; after a turn, the idle
   * transition says it.
   */
  | { kind: 'ready' };

/**
 * Whether the CLI is mid-turn, tracked across chunks.
 *
 * Only transitions are interesting — the title is repainted many times per
 * second — so `observe` answers with a change when there is one and null
 * otherwise, which is what keeps the renderer from being told the same thing
 * sixty times a second.
 *
 * Two sources, one of which wins. A CLI that speaks OSC 7501 says outright
 * what its root record is doing, and from its first report on that is the only
 * thing listened to: the title and OSC 9;4 keep arriving alongside it, and on
 * CLI 2.1.301 the title keeps its last spinner frame after a turn ends, so
 * letting both drive would have them fight. Child records (subagents) do not
 * move the session's state.
 *
 * Without 7501 — an older CLI, or a remote session whose tmux answered the
 * probe's DA query first — the legacy rules apply: OSC 0 is authoritative in
 * both directions, and OSC 9;4 progress can only start a turn, because its
 * `4;0` "clear" is also emitted at startup and after permission prompts, which
 * makes it useless as an idle signal.
 */
export class CliBusyTracker {
  #busy = false;
  #sawIdleTitle = false;
  /** Set by the first 7501 report; from then on 7501 alone drives state. */
  #speaksProgramStatus = false;
  /** The root record's current block, so a repeated report is not re-announced. */
  #blockedOn: string | null = null;
  /** Set once the CLI has been seen at its prompt. */
  #ready = false;

  get busy(): boolean {
    return this.#busy;
  }

  /**
   * True once the CLI has been seen at its prompt, idle: it can take input.
   * A session that just started is not busy, but not ready either.
   */
  get ready(): boolean {
    return this.#ready;
  }

  /** True once an OSC 0 idle glyph has been seen — the CLI is at a prompt. */
  get sawIdleTitle(): boolean {
    return this.#sawIdleTitle;
  }

  /** True once the CLI has sent an OSC 7501 report. */
  get speaksProgramStatus(): boolean {
    return this.#speaksProgramStatus;
  }

  observe(event: TerminalEvent): CliStateChange | null {
    if (event.kind === 'program-status') return this.#observeProgramStatus(event);
    if (this.#speaksProgramStatus) return null;

    if (event.kind === 'title') {
      if (titleMeansBusy(event.text) && !this.#busy) {
        this.#busy = true;
        this.#sawIdleTitle = false;
        return { kind: 'busy', busy: true };
      }
      if (titleMeansIdle(event.text) && this.#busy) {
        this.#busy = false;
        this.#sawIdleTitle = true;
        this.#ready = true;
        return { kind: 'busy', busy: false };
      }
      if (titleMeansIdle(event.text) && !this.#ready) {
        this.#ready = true;
        return { kind: 'ready' };
      }
      return null;
    }
    if (event.kind === 'progress') {
      if (event.level === '0') return null;
      if ((event.level === '1' || event.level === '2' || event.level === '3') && !this.#busy) {
        this.#busy = true;
        this.#sawIdleTitle = false;
        return { kind: 'busy', busy: true };
      }
    }
    return null;
  }

  /**
   * A 7501 root report: working is busy; idle, done, error and a cleared
   * record are not; blocked leaves busy alone and asks for the user.
   *
   * A blocked report is announced when the block is new — entering it, or
   * moving straight on to a different prompt — not on every repeat of the
   * same one.
   */
  #observeProgramStatus(report: ProgramStatusReport): CliStateChange | null {
    this.#speaksProgramStatus = true;
    if (report.id !== undefined) return null;

    if (report.state === 'blocked') {
      const block = `${report.blockedOn ?? ''}:${report.msg ?? ''}`;
      if (this.#blockedOn === block) return null;
      this.#blockedOn = block;
      return { kind: 'needs-attention' };
    }
    this.#blockedOn = null;

    const busy = report.state === 'working';
    if (busy === this.#busy) {
      if (busy || this.#ready) return null;
      this.#ready = true;
      return { kind: 'ready' };
    }
    this.#busy = busy;
    if (!busy) this.#ready = true;
    return { kind: 'busy', busy };
  }
}
