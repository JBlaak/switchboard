/**
 * Syntax colouring without an editor.
 *
 * The long diff renders every changed file of a worktree in one scroll, and a
 * 212-file diff cannot be 212 CodeMirror instances: `MergeView` owns two
 * `EditorState`s apiece, and even a read-only `EditorView` per file would cost
 * more than the scroll is worth. So the scroll is plain DOM with pre-coloured
 * spans, and a live editor is built only for the one file the user opens
 * (invariant 8 in DESIGN.md).
 *
 * The colours come out as `tok-*` classes rather than inline styles, which is
 * what `classHighlighter` emits; `styles/_code-highlight.scss` paints them from
 * the same dracula `config` the live editor is themed from, so the two surfaces
 * cannot drift apart on hue. They can still differ slightly in *precision* —
 * see that file — because the class-based highlighter is coarser than the
 * editor's `HighlightStyle`.
 *
 * Everything here is DOM-free on purpose: it is string in, string out, so it
 * runs under plain Node in tests and could run off the main thread later.
 */

import { highlightCode, classHighlighter } from '@lezer/highlight';
import type { LanguageSupport } from '@codemirror/language';

import { languageForFilename } from './codemirror-setup';

/**
 * The Lezer parser type, reached through `LanguageSupport` rather than imported
 * from `@lezer/common`. Both name the same type, but `@lezer/common` is only a
 * transitive dependency here — going through the package we do depend on keeps
 * package.json honest about what this file needs.
 */
type LezerParser = LanguageSupport['language']['parser'];

/**
 * A language, reduced to what colouring actually needs.
 *
 * Resolved once per file and then handed to every line of it, because
 * `languageForFilename` builds a whole `LanguageSupport` — extensions,
 * facets, the lot — and a diff asks about the same file hundreds of times.
 */
export interface HighlightLanguage {
  /** The language's own name (`typescript`, `sass`, …). Useful in tests. */
  readonly name: string;
  /** The parser whose tree the colours are read off. */
  readonly parser: LezerParser;
}

/**
 * Beyond this many lines in one call, colouring is skipped.
 *
 * Not a correctness limit but a latency one: a generated file — a lockfile, a
 * migration, a checked-in bundle — is exactly the kind of thing a diff is full
 * of, and nobody reads its colours. The diff view can call this per hunk to
 * stay under the cap on files that are genuinely long.
 */
export const MAX_HIGHLIGHT_LINES = 2000;

/**
 * A single line this long turns colouring off for the whole call.
 *
 * One minified line is the pathological case: a 1.6 MB single-line bundle would
 * park the parser on the renderer's only thread with no frame to yield on. The
 * check is on the longest line rather than the total because that is where the
 * cost actually is — the parser does not care how the characters are split, but
 * a line this long is a reliable tell that the file is machine-written.
 */
export const MAX_HIGHLIGHT_LINE_LENGTH = 2000;

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escape text for interpolation into HTML.
 *
 * `lib/format.ts` already has an `escapeHtml`, and this is deliberately not it:
 * that one round-trips through `document.createElement`, which needs a DOM and
 * allocates an element per call. A diff calls this once per token, so the cost
 * would be hundreds of thousands of elements, and the tests for this file would
 * need a DOM to run at all.
 *
 * A diff is full of `<`, `>` and `&` — generics, shell redirects, entities in
 * HTML fixtures. Getting this wrong is an injection bug, not a cosmetic one, so
 * every path out of this module goes through here, including the un-tokenised
 * gaps between spans.
 */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

function toLanguage(support: LanguageSupport): HighlightLanguage {
  return { name: support.language.name, parser: support.language.parser };
}

/**
 * Work out how to colour a file, once, so its lines can be coloured many times.
 *
 * Wraps `languageForFilename` so this module and the live editor share one
 * extension table instead of growing a second copy. `null` means no
 * highlighting is available, and the caller still gets correctly escaped text
 * from the functions below — plain text is a perfectly good end state.
 *
 * Only the synchronous half of the resolution is used. A language that
 * `@codemirror/language-data` knows but `LANG_MAP` does not needs an async
 * `load()` before its parser exists, and a scroll being built right now cannot
 * wait on that; `loadHighlightLanguage` is the door out of that for callers who
 * can await.
 */
export function highlightLanguageFor(filename: string): HighlightLanguage | null {
  const { support } = languageForFilename(filename);
  return support ? toLanguage(support) : null;
}

/**
 * The awaitable form, covering the ~100 languages only `language-data` knows.
 *
 * A worktree diff is full of `.toml`, `.sh` and `.rb`, none of which resolve
 * synchronously, so a caller that can resolve languages ahead of painting
 * should prefer this one and fall back to plain text on failure. In practice
 * the wait is a microtask — the renderer bundles as one IIFE with no code
 * splitting, so esbuild has already inlined every parser `language-data` can
 * reach — but the await is the contract and has to be honoured.
 */
export async function loadHighlightLanguage(filename: string): Promise<HighlightLanguage | null> {
  const resolved = languageForFilename(filename);
  if (resolved.support) return toLanguage(resolved.support);
  if (!resolved.deferred) return null;
  try {
    return toLanguage(await resolved.deferred.load());
  } catch {
    // No parser to be had. Plain text, same as an unrecognised extension.
    return null;
  }
}

/**
 * Colour a block of lines, returning one string of HTML per line.
 *
 * **The whole block is parsed as one document**, not line by line. That matters
 * because a line torn out of its file is rarely valid syntax on its own: the
 * body of a block comment parses as code, the middle of a template literal
 * parses as expressions, and a closing brace parses as an error. Parsing the
 * block gives every construct that opens and closes *inside it* the right
 * colour.
 *
 * It does not fix constructs that open *before* the block. The diff view only
 * ever holds hunks, never whole files, so a hunk that begins inside a block
 * comment will still be coloured as code — and that is the honest limit of what
 * this can do with what the caller can supply. Pass the largest contiguous
 * chunk you have (a whole file when you have one, a hunk when you don't) and
 * the mis-colouring shrinks accordingly.
 *
 * Always returns exactly one entry per input line, including trailing empty
 * ones: the diff view pairs these against line numbers, and a row count that
 * drifts would misalign the gutter against the code.
 */
export function highlightLines(lines: readonly string[], lang: HighlightLanguage | null): string[] {
  if (lines.length === 0) return [];

  const plain = () => lines.map(escapeHtml);
  if (!lang) return plain();
  if (lines.length > MAX_HIGHLIGHT_LINES) return plain();
  for (const line of lines) if (line.length > MAX_HIGHLIGHT_LINE_LENGTH) return plain();

  const code = lines.join('\n');
  const out: string[] = [''];
  try {
    const tree = lang.parser.parse(code);
    // `highlightCode` is `highlightTree` plus the one thing this needs and
    // getting right by hand is fiddly: it splits styled ranges at newlines, so
    // a multi-line token arrives as one call per line and no span ever
    // straddles a row boundary.
    highlightCode(
      code,
      tree,
      classHighlighter,
      (text, classes) => {
        // `classes` comes from `classHighlighter`, which emits a fixed
        // vocabulary of `tok-*` names — never anything derived from the file.
        out[out.length - 1] += classes
          ? `<span class="${classes}">${escapeHtml(text)}</span>`
          : escapeHtml(text);
      },
      () => { out.push(''); },
    );
  } catch {
    // A parser that throws on some input it dislikes must not take the scroll
    // down with it. Uncoloured is a fine answer; blank is not.
    return plain();
  }

  // Belt and braces on the row count. The break callback fires once per newline
  // walked, so this should hold by construction — but if a parser ever made it
  // not, silently uncoloured beats a diff whose line numbers have slipped.
  return out.length === lines.length ? out : plain();
}

/**
 * Colour one line, returning one string of HTML.
 *
 * The single-line convenience over `highlightLines`, and it inherits that
 * function's limitation in its sharpest form: a line on its own carries no
 * context at all, so anything spanning lines is mis-coloured. Prefer
 * `highlightLines` with the largest block you have wherever you have a choice.
 *
 * Newlines in `code` are honoured rather than rejected — the result is the
 * coloured lines joined back with `\n`.
 */
export function highlightLine(code: string, lang: HighlightLanguage | null): string {
  return highlightLines(code.split('\n'), lang).join('\n');
}
