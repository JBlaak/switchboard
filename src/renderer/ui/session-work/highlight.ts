/**
 * Syntax highlighting for the diff view, with highlight.js.
 *
 * Only highlight.js's core is loaded up front. A language is registered the
 * first time a diff shows a file in it, so a page of TypeScript never pays for
 * Rust's grammar. (The renderer is one bundle, so "loading" a language means
 * evaluating and registering its module, not fetching it.) A file whose
 * extension names no language here renders as plain text.
 *
 * Which languages are registered is a small registry outside the store, like
 * the terminals: it holds library state, not page state. Components subscribe
 * to it (`subscribeLanguages`) to redraw once a language arrives.
 */
import hljs from 'highlight.js/lib/core';
import type { LanguageFn } from 'highlight.js';
import type { SplitRow, UnifiedRow } from '../../../domain/session-work/diff-layout';

type Loader = () => Promise<{ default: LanguageFn }>;

/** Every language the diff can highlight, each imported only when first needed. */
const LOADERS: Record<string, Loader> = {
  bash: () => import('highlight.js/lib/languages/bash'),
  c: () => import('highlight.js/lib/languages/c'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  css: () => import('highlight.js/lib/languages/css'),
  dart: () => import('highlight.js/lib/languages/dart'),
  diff: () => import('highlight.js/lib/languages/diff'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  elixir: () => import('highlight.js/lib/languages/elixir'),
  go: () => import('highlight.js/lib/languages/go'),
  graphql: () => import('highlight.js/lib/languages/graphql'),
  haskell: () => import('highlight.js/lib/languages/haskell'),
  ini: () => import('highlight.js/lib/languages/ini'),
  java: () => import('highlight.js/lib/languages/java'),
  javascript: () => import('highlight.js/lib/languages/javascript'),
  json: () => import('highlight.js/lib/languages/json'),
  kotlin: () => import('highlight.js/lib/languages/kotlin'),
  lua: () => import('highlight.js/lib/languages/lua'),
  makefile: () => import('highlight.js/lib/languages/makefile'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  nix: () => import('highlight.js/lib/languages/nix'),
  objectivec: () => import('highlight.js/lib/languages/objectivec'),
  perl: () => import('highlight.js/lib/languages/perl'),
  php: () => import('highlight.js/lib/languages/php'),
  properties: () => import('highlight.js/lib/languages/properties'),
  protobuf: () => import('highlight.js/lib/languages/protobuf'),
  python: () => import('highlight.js/lib/languages/python'),
  r: () => import('highlight.js/lib/languages/r'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  rust: () => import('highlight.js/lib/languages/rust'),
  scala: () => import('highlight.js/lib/languages/scala'),
  scss: () => import('highlight.js/lib/languages/scss'),
  sql: () => import('highlight.js/lib/languages/sql'),
  swift: () => import('highlight.js/lib/languages/swift'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  xml: () => import('highlight.js/lib/languages/xml'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
};

/** File extension (lower case, no dot) → language. */
const BY_EXTENSION: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', json5: 'json',
  css: 'css', scss: 'scss',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', plist: 'xml', vue: 'xml',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  yml: 'yaml', yaml: 'yaml',
  toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', editorconfig: 'ini',
  properties: 'properties',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  py: 'python', pyi: 'python',
  go: 'go', rs: 'rust', swift: 'swift', kt: 'kotlin', kts: 'kotlin', java: 'java',
  rb: 'ruby', rake: 'ruby', gemspec: 'ruby', php: 'php', sql: 'sql',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp', m: 'objectivec', mm: 'objectivec',
  lua: 'lua', dart: 'dart', ex: 'elixir', exs: 'elixir', hs: 'haskell', nix: 'nix',
  proto: 'protobuf', graphql: 'graphql', gql: 'graphql', scala: 'scala',
  pl: 'perl', pm: 'perl', r: 'r', diff: 'diff', patch: 'diff',
};

/** Files known by their whole name rather than an extension. */
const BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile', containerfile: 'dockerfile',
  makefile: 'makefile', gnumakefile: 'makefile',
  gemfile: 'ruby', rakefile: 'ruby', podfile: 'ruby', brewfile: 'ruby',
  '.bashrc': 'bash', '.zshrc': 'bash', '.profile': 'bash',
};

/** The language a file is highlighted as, by its name; null for plain text. */
export function languageFor(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  if (name.startsWith('dockerfile.')) return 'dockerfile';
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  return BY_EXTENSION[name.slice(dot + 1)] ?? null;
}

// ── The registry ──

const loading = new Map<string, Promise<boolean>>();
const listeners = new Set<() => void>();

/** Is this language registered, so `highlightLines` can use it? */
export function isLanguageReady(language: string): boolean {
  return hljs.getLanguage(language) !== undefined;
}

/** Register a language if it is not yet; answers whether it is now. Listeners hear of each new one. */
export function ensureLanguage(language: string): Promise<boolean> {
  if (isLanguageReady(language)) return Promise.resolve(true);
  const load = LOADERS[language];
  if (!load) return Promise.resolve(false);
  let pending = loading.get(language);
  if (!pending) {
    pending = load()
      .then((module) => {
        hljs.registerLanguage(language, module.default);
        for (const listener of [...listeners]) listener();
        return true;
      })
      .catch(() => false);
    loading.set(language, pending);
  }
  return pending;
}

/** Be told when a language is registered. Answers the unsubscribe. */
export function subscribeLanguages(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// ── Highlighting ──

/**
 * Highlight consecutive lines of one side of a file, as HTML per line; null
 * when the language is not registered (yet), which renders plain text.
 *
 * The lines are highlighted together, so a string or comment that spans
 * several of them is read as one, and then cut back into lines.
 */
export function highlightLines(texts: readonly string[], language: string | null): string[] | null {
  if (!language || !isLanguageReady(language) || texts.length === 0) return null;
  try {
    const html = hljs.highlight(texts.join('\n'), { language, ignoreIllegals: true }).value;
    const lines = splitHighlighted(html);
    return lines.length === texts.length ? lines : null;
  } catch {
    return null;
  }
}

/**
 * The highlighted HTML of each unified row in `rows[start, end)`, by offset
 * from `start`: hunk headers get null. Null altogether when the language is
 * not ready. Each side of the file is highlighted as one run — the old file's
 * lines (context and deletions) and the new file's (context and additions) —
 * so a deleted line reads in the context it was written in.
 */
export function highlightUnifiedRows(
  rows: readonly UnifiedRow[], start: number, end: number, language: string | null,
): Array<string | null> | null {
  if (!language || !isLanguageReady(language)) return null;
  const old = new Side();
  const now = new Side();
  for (let i = start; i < end; i++) {
    const row = rows[i];
    if (row.kind !== 'line') continue;
    if (row.line.kind !== 'add') old.add(i - start, row.line.text);
    if (row.line.kind !== 'delete') now.add(i - start, row.line.text);
  }
  const html: Array<string | null> = new Array(end - start).fill(null);
  // Context lines are on both sides; the new side's reading of them wins.
  old.highlight(language, html);
  now.highlight(language, html);
  return html;
}

/** The same for split rows: each side's HTML by offset from `start`, null where there is no line. */
export function highlightSplitRows(
  rows: readonly SplitRow[], start: number, end: number, language: string | null,
): { left: Array<string | null>; right: Array<string | null> } | null {
  if (!language || !isLanguageReady(language)) return null;
  const left = new Side();
  const right = new Side();
  for (let i = start; i < end; i++) {
    const row = rows[i];
    if (row.kind !== 'pair') continue;
    if (row.left) left.add(i - start, row.left.text);
    if (row.right) right.add(i - start, row.right.text);
  }
  const out = { left: new Array<string | null>(end - start).fill(null), right: new Array<string | null>(end - start).fill(null) };
  left.highlight(language, out.left);
  right.highlight(language, out.right);
  return out;
}

/** One side's lines in order, and the row each belongs to. */
class Side {
  readonly #at: number[] = [];
  readonly #texts: string[] = [];

  add(at: number, text: string): void {
    this.#at.push(at);
    this.#texts.push(text);
  }

  /** Write each line's HTML into `into` at its row; leaves `into` alone when highlighting fails. */
  highlight(language: string, into: Array<string | null>): void {
    const html = highlightLines(this.#texts, language);
    if (!html) return;
    this.#at.forEach((at, i) => { into[at] = html[i]; });
  }
}

/**
 * Cut highlight.js's HTML into one string per line.
 *
 * A token can span lines (a block comment, a template string), so a line
 * break inside a `<span>` closes every open span at the end of the line and
 * opens them again at the start of the next, leaving each line well formed.
 * highlight.js writes nothing but `<span class="…">`, `</span>` and escaped
 * text, which is all this has to understand.
 */
export function splitHighlighted(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let line = '';
  let from = 0;
  const token = /<span[^>]*>|<\/span>|\n/g;
  for (let match = token.exec(html); match; match = token.exec(html)) {
    line += html.slice(from, match.index);
    from = token.lastIndex;
    const tag = match[0];
    if (tag === '\n') {
      lines.push(line + '</span>'.repeat(open.length));
      line = open.join('');
    } else {
      if (tag === '</span>') open.pop();
      else open.push(tag);
      line += tag;
    }
  }
  lines.push(line + html.slice(from));
  return lines;
}
