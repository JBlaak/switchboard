/**
 * Pure terminal input and font helpers.
 *
 * These decide things — is this keydown an IME composition, what does an OSC 52
 * payload mean, what font settings will xterm accept — without touching a
 * terminal, the DOM or any renderer state. terminal-manager.ts is where they
 * get used; keeping them here is what lets the tests exercise them in Node.
 */

// Global font settings shared by every xterm instance. Mutated by applyTerminalFont
// when the user saves global settings (or on startup, from the stored settings).
export const DEFAULT_TERMINAL_FONT_FAMILY = "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace";
export const DEFAULT_TERMINAL_FONT_SIZE = 12;
export const DEFAULT_TERMINAL_LINE_HEIGHT = 1;

/** Font settings as they are stored — every field optional and unvalidated. */
export interface StoredFontSettings {
  fontFamily?: unknown;
  fontSize?: unknown;
  lineHeight?: unknown;
}

/** Font settings xterm will accept. */
export interface TerminalFontSettings {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
}

// Always leave a monospace font behind the user's choice. A family the browser cannot
// resolve — a typo, or a font the user names but hasn't installed — is not an error in
// CSS: Chromium silently falls back to its default *proportional* font, which destroys
// the terminal's column alignment. Keeping the default stack as a tail means an
// unresolvable name degrades to the normal terminal font instead.
function withMonospaceFallback(family: string): string {
  if (family === DEFAULT_TERMINAL_FONT_FAMILY) return family;
  return family + ', ' + DEFAULT_TERMINAL_FONT_FAMILY;
}

// Coerce stored settings into values xterm accepts. xterm throws outright on
// lineHeight < 1, so unset/out-of-range values fall back to (or clamp toward) the
// defaults.
//
// The chosen family is always followed by the default stack rather than used alone
// (see withMonospaceFallback). A name that doesn't resolve (a typo, or a font that
// isn't installed on this machine) otherwise falls through to the proportional
// default, and xterm renders that as badly-stretched text with uneven cell widths —
// see isFontAvailable, which warns about the same mistake up front in the settings
// panel.
export function normalizeTerminalFont(
  { fontFamily, fontSize, lineHeight }: StoredFontSettings = {},
): TerminalFontSettings {
  const chosen = typeof fontFamily === 'string' ? fontFamily.trim() : '';
  const family = chosen || DEFAULT_TERMINAL_FONT_FAMILY;
  const size = Number(fontSize);
  const height = Number(lineHeight);
  return {
    fontFamily: withMonospaceFallback(family),
    fontSize: Number.isFinite(size) && size > 0 ? Math.min(32, Math.max(6, size)) : DEFAULT_TERMINAL_FONT_SIZE,
    lineHeight: Number.isFinite(height) && height > 0 ? Math.min(3, Math.max(1, height)) : DEFAULT_TERMINAL_LINE_HEIGHT,
  };
}


// True when a keydown is being consumed by an IME (e.g. Korean/Japanese/Chinese)
// to compose a character. Chromium reports keyCode 229 for such keydowns, and
// sets isComposing while a composition is active. xterm's own _keyDown defers to
// its composition helper in this state — but only if our custom handler lets the
// event through (returns true) instead of intercepting it.
export function isImeComposing(e: KeyboardEvent): boolean {
  return e.isComposing === true || e.keyCode === 229;
}

// Whether a Space keydown should be written straight to the PTY (the push-to-talk
// key-repeat path from #22) rather than left to xterm. It must NOT fire during IME
// composition: preventDefault-ing the Space there drops the in-progress syllable
// (e.g. Korean "녕 " came out as " 녕" or lost the syllable entirely).
export function shouldSendSpaceDirectly(e: KeyboardEvent): boolean {
  return e.key === ' '
    && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey
    && !isImeComposing(e);
}

// Decode an OSC 52 payload into the text the program wants on the clipboard.
// Payload is "<selection>;<base64>", e.g. "c;aGVsbG8=".
//
// Returns null when there is nothing to write — an empty payload, or a read-back
// query ("<selection>;?"). The read-back case is a deliberate refusal, not a gap:
// answering it would write the user's clipboard contents back into the terminal,
// letting any program running in the session exfiltrate whatever they last
// copied. We consume the sequence and stay silent. Do not "finish" this by
// implementing the query response.
//
// Throws on malformed base64 (atob), which the caller reports as unhandled.
export function decodeOsc52Payload(payload: string): string | null {
  const sep = payload.indexOf(';');
  const b64 = sep === -1 ? payload : payload.slice(sep + 1);
  if (!b64 || b64 === '?') return null;
  const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

