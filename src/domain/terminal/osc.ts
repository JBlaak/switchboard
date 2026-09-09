/**
 * What a PTY's byte stream says about the CLI running in it.
 *
 * Claude CLI narrates itself through terminal escape sequences meant for a
 * terminal emulator: the window title (OSC 0) carries a braille spinner while a
 * turn is in flight and a `✳` when it is waiting, OSC 9 carries iTerm2-style
 * notifications and progress, and the alternate-screen switch says a TUI has
 * taken over. Reading those is how a session's state reaches the sidebar without
 * asking the CLI anything.
 *
 * Parsing is separated from the state it feeds so both can be tested against a
 * plain string.
 */

/** One thing a chunk of PTY output said. */
export type TerminalEvent =
  | { kind: 'title'; text: string }
  | { kind: 'progress'; level: string }
  | { kind: 'notification'; message: string }
  | { kind: 'alt-screen'; active: boolean }
  | { kind: 'bell' };

/** How much of an OSC payload is kept — titles and messages are short. */
const PAYLOAD_LIMIT = 120;

/** Braille block: the CLI's spinner frames all live in it. */
const SPINNER_FIRST = 0x2800;
const SPINNER_LAST = 0x28ff;
/** `✳` — the CLI's "waiting for you" glyph. */
const IDLE_GLYPH = '✳';

/** Does this OSC 0 title mean a turn is in flight? */
export function titleMeansBusy(title: string): boolean {
  const code = title.charAt(0).charCodeAt(0);
  return code >= SPINNER_FIRST && code <= SPINNER_LAST;
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
    for (const m of data.matchAll(/\x1b\](\d+);([^\x07\x1b]*)(?:\x07|\x1b\\)/g)) {
      if (m[1] === '0') events.push({ kind: 'title', text: m[2].slice(0, PAYLOAD_LIMIT) });
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
 * Whether the CLI is mid-turn, tracked across chunks.
 *
 * Only transitions are interesting — the title is repainted many times per
 * second — so `observe` answers with the new value when it changed and null
 * otherwise, which is what keeps the renderer from being told the same thing
 * sixty times a second.
 *
 * OSC 0 is authoritative in both directions. OSC 9;4 progress can only start a
 * turn: its `4;0` "clear" is also emitted for other reasons, which makes it
 * useless as an idle signal.
 */
export class CliBusyTracker {
  #busy = false;
  #sawIdleTitle = false;

  get busy(): boolean {
    return this.#busy;
  }

  /** True once an OSC 0 idle glyph has been seen — the CLI is at a prompt. */
  get sawIdleTitle(): boolean {
    return this.#sawIdleTitle;
  }

  observe(event: TerminalEvent): boolean | null {
    if (event.kind === 'title') {
      if (titleMeansBusy(event.text) && !this.#busy) {
        this.#busy = true;
        this.#sawIdleTitle = false;
        return true;
      }
      if (titleMeansIdle(event.text) && this.#busy) {
        this.#busy = false;
        this.#sawIdleTitle = true;
        return false;
      }
      return null;
    }
    if (event.kind === 'progress') {
      if (event.level === '0') return null;
      if ((event.level === '1' || event.level === '2' || event.level === '3') && !this.#busy) {
        this.#busy = true;
        this.#sawIdleTitle = false;
        return true;
      }
    }
    return null;
  }
}
