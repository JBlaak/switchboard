/**
 * The flip's rules, with no DOM in them.
 *
 * Which of the three surfaces each mode wants, what ⌘J does from each mode,
 * which half is folded, and how a mode is read back out of Web Storage. All of
 * it decided here so it can be tested by calling a function — `main-mode.ts`
 * moves elements and refits terminals and decides nothing else worth asserting
 * on, which is the same split `rail-model.ts` and `changes-list-model.ts` keep.
 *
 * Kept free of `../lib/dom`, which resolves every element handle at import and
 * so cannot be reached from a test. `session-store` is reachable: it holds the
 * storage keys and the two guarded Web Storage helpers, and touches no element.
 *
 * **The mode is two axes, not one.** The code area is a sibling of
 * `#terminal-area` under `#main` and goes through `showViewer`; the file panel
 * is created at runtime *inside* `#terminal-area` by `initFilePanel()`. No
 * single one-of-N enum can say "terminal with the split open" and "code area
 * instead of the terminal" at the same time, which is why a mode names a pair
 * of independent facts rather than one panel.
 */
import { STORAGE_KEYS, readStored, writeStored } from '../state/session-store';

/** Which half owns the window. */
export type MainMode = 'talk' | 'split' | 'code';

/** In the order the segmented control shows them. */
export const MAIN_MODES: readonly MainMode[] = ['talk', 'split', 'code'];

/** What one mode wants of the three surfaces the flip moves. */
export interface MainSurfaces {
  /** `#terminal-area` — the conversation, and everything inside it. */
  terminal: boolean;
  /** `#file-panel` — the split that lives inside the terminal area. */
  filePanel: boolean;
  /** `#code-area` — the viewer beside the terminal area, not inside it. */
  code: boolean;
}

/**
 * The whole of the milestone, as a table.
 *
 * `split` is `talk` with the panel out, not a third place: the same terminal,
 * the same scrollback, one more column. `code` is the only row that takes the
 * terminal off screen — and even then it is hidden, never unmounted.
 */
const SURFACES: Record<MainMode, MainSurfaces> = {
  talk:  { terminal: true,  filePanel: false, code: false },
  split: { terminal: true,  filePanel: true,  code: false },
  code:  { terminal: false, filePanel: false, code: true  },
};

export function surfacesFor(mode: MainMode): MainSurfaces {
  return SURFACES[mode];
}

/**
 * Where ⌘J goes from here.
 *
 * It bounces the outer two, so `talk` and `code` swap. From `split` both halves
 * are already on screen, and the useful next thing is the one the split cannot
 * give you: the code side with the whole window. Coming back from there lands
 * on `talk`, not `split` — the user chose `split` explicitly and can choose it
 * again, and a gesture that remembers a third state is a gesture nobody can
 * predict.
 */
export function flipped(mode: MainMode): MainMode {
  return mode === 'code' ? 'talk' : 'code';
}

/** The half that is folded to a strip, or neither when both are on screen. */
export function foldedHalf(mode: MainMode): 'code' | 'conversation' | null {
  if (mode === 'talk') return 'code';
  if (mode === 'code') return 'conversation';
  return null;
}

/**
 * A stored mode, or `talk`.
 *
 * Anything unrecognised — a hand-edited value, the spelling some later build
 * uses — reads as `talk` rather than breaking the flip, exactly as the scope
 * store treats a malformed scope as "All".
 */
export function parseMainMode(raw: string | null | undefined): MainMode {
  return raw === 'split' || raw === 'code' ? raw : 'talk';
}

/**
 * Where one session's mode is kept.
 *
 * Per session, not global: a session you were reading stays on `code` while the
 * one you switch to stays wherever you left it. `sessionStorage` rather than
 * `localStorage` because a mode belongs to a window's visit — the sessions a
 * window has open are already remembered there, and a mode outliving them would
 * put a machine you have not opened yet straight into a code view.
 */
export function modeStorageKey(sessionId: string): string {
  return `${STORAGE_KEYS.mainMode}:${sessionId}`;
}

/** The mode a session was left in, or `talk` for one never flipped. */
export function readSessionMode(sessionId: string): MainMode {
  return parseMainMode(readStored('sessionStorage', modeStorageKey(sessionId)));
}

/**
 * Remember a session's mode. `talk` is forgotten rather than written: it is the
 * answer an absent key already gives, and one entry per session the user merely
 * looked at is not worth keeping.
 */
export function writeSessionMode(sessionId: string, mode: MainMode): void {
  writeStored('sessionStorage', modeStorageKey(sessionId), mode === 'talk' ? null : mode);
}

/**
 * A line of terminal output worth quoting on the folded conversation strip.
 *
 * Given the tail of the buffer, newest line last. The CLI's input box is
 * drawn on the last few rows and repainted constantly, so the newest *line* is
 * almost never the newest *message*: this walks back past the blank rows, the
 * box rules, and an empty prompt, and stops at the first row with something
 * said on it. Nothing is found in a terminal that has only ever shown a prompt,
 * which is honest — there is no last message yet.
 */
export function lastMessageLine(lines: readonly string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].replace(/\s+/g, ' ').trim();
    if (line === '' || FURNITURE.test(line) || isRule(line)) continue;
    return line.length > MAX_LINE ? line.slice(0, MAX_LINE - 1) + '…' : line;
  }
  return '';
}

/** Rows that are the CLI's frame rather than anything it said. */
const FURNITURE = /^[\s─━═│┃╭╮╰╯┌┐└┘├┤┬┴┼╌·.>›❯$#%*+~^_|-]*$/;

/** Every character that is drawing a line rather than spelling a word. */
const RULE_CHARS = /[─━═╌╍┅┉│┃╭╮╰╯┌┐└┘├┤┬┴┼]/g;

/**
 * A banner: a rule with a label sitting in the middle of it.
 *
 * `FURNITURE` only catches a row that is *entirely* frame, and Switchboard
 * writes its own session banner as `──── name ────`, which has a word in it and
 * so reads as something said. Judging by proportion instead catches both: a rule
 * is mostly rule however it is labelled, and a sentence is almost never more
 * than a few percent box-drawing. Measured on a real session, whose banner came
 * to 142 characters with 114 of them a dash.
 */
function isRule(line: string): boolean {
  if (line.length < 12) return false;
  const drawn = line.match(RULE_CHARS)?.length ?? 0;
  return drawn / line.length > 0.5;
}

/** Long enough to be a sentence, short enough that the strip never reflows. */
const MAX_LINE = 200;
