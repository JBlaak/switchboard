import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, highlightSpecialChars, ViewPlugin, Decoration } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { EditorState, StateField, StateEffect, Compartment } from '@codemirror/state';
import { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import type { LanguageSupport } from '@codemirror/language';
import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, foldGutter, foldKeymap, LanguageDescription } from '@codemirror/language';
import { highlightSelectionMatches } from '@codemirror/search';
import { dracula } from '@ddietr/codemirror-themes/theme/dracula';
import { tags } from '@lezer/highlight';
import { MergeView, unifiedMergeView } from '@codemirror/merge';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { marked } from 'marked';
import { rust } from '@codemirror/lang-rust';
import { go } from '@codemirror/lang-go';
import { java } from '@codemirror/lang-java';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { sql } from '@codemirror/lang-sql';
import { cpp } from '@codemirror/lang-cpp';
import { sass } from '@codemirror/lang-sass';
import { less } from '@codemirror/lang-less';

const markdownExtras = HighlightStyle.define([
  { tag: tags.monospace, color: '#8BE9FD' },
]);

const appThemePatch = EditorView.theme({
  '&': { height: '100%', fontSize: '12.5px' },
  '.cm-content': { padding: '20px 8px' },
  '.cm-scroller': {
    scrollbarWidth: 'thin',
    scrollbarColor: 'rgba(255,255,255,0.08) transparent',
  },
}, { dark: true });

// ── Custom floating search bar (matches xterm search bar style) ──────

const setSearchQuery = StateEffect.define<string | null>();
const searchQueryField = StateField.define<string | null>({
  create() { return null; },
  update(val, tr) {
    for (const e of tr.effects) if (e.is(setSearchQuery)) return e.value;
    return val;
  },
});

const searchHighlighter = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) { this.decorations = this._build(view); }

  update(update: ViewUpdate) {
    if (update.docChanged || update.state.field(searchQueryField) !== update.startState.field(searchQueryField)) {
      this.decorations = this._build(update.view);
    }
  }

  _build(view: EditorView): DecorationSet {
    const q = view.state.field(searchQueryField);
    if (!q) return Decoration.none;
    const decs = [];
    const doc = view.state.doc.toString();
    const term = q.toLowerCase();
    let pos = 0;
    while ((pos = doc.toLowerCase().indexOf(term, pos)) !== -1) {
      decs.push(Decoration.mark({ class: 'cm-find-match' }).range(pos, pos + term.length));
      pos += term.length;
    }
    return Decoration.set(decs);
  }
}, { decorations: v => v.decorations });

const cmSearchTheme = EditorView.theme({
  '.cm-find-match': { backgroundColor: '#515C6A', borderRadius: '2px' },
  '.cm-find-match-active': { backgroundColor: '#EAA549', borderRadius: '2px' },
});

function cmFloatingSearch() {
  return [searchQueryField, searchHighlighter, cmSearchTheme];
}

function createCMSearchBar(parent: HTMLElement, view: EditorView) {
  const bar = document.createElement('div');
  bar.className = 'terminal-search-bar';
  bar.style.display = 'none';
  bar.innerHTML = `
    <input type="text" class="terminal-search-input" placeholder="Find..." />
    <span class="terminal-search-count"></span>
    <button class="terminal-search-prev" title="Previous (Shift+Enter)">&#x25B2;</button>
    <button class="terminal-search-next" title="Next (Enter)">&#x25BC;</button>
    <button class="terminal-search-close" title="Close (Escape)">&times;</button>
  `;
  parent.style.position = 'relative';
  parent.appendChild(bar);

  // Every node below is markup this function just wrote, so the lookups cannot miss.
  const input = bar.querySelector<HTMLElement>('.terminal-search-input') as HTMLInputElement;
  const countEl = bar.querySelector<HTMLElement>('.terminal-search-count') as HTMLElement;
  let matches: number[] = [];
  let activeIdx = -1;

  function findAll() {
    const q = input.value;
    matches = [];
    activeIdx = -1;
    if (!q) {
      view.dispatch({ effects: setSearchQuery.of(null) });
      countEl.textContent = '';
      return;
    }
    view.dispatch({ effects: setSearchQuery.of(q) });
    const doc = view.state.doc.toString();
    const term = q.toLowerCase();
    let pos = 0;
    while ((pos = doc.toLowerCase().indexOf(term, pos)) !== -1) {
      matches.push(pos);
      pos += term.length;
    }
    countEl.textContent = matches.length > 0 ? `${matches.length} found` : 'No results';
  }

  function goTo(idx: number) {
    if (matches.length === 0) return;
    activeIdx = ((idx % matches.length) + matches.length) % matches.length;
    const pos = matches[activeIdx];
    const q = input.value;
    view.dispatch({
      selection: { anchor: pos, head: pos + q.length },
      scrollIntoView: true,
    });
    countEl.textContent = `${activeIdx + 1} of ${matches.length}`;
  }

  function open() {
    bar.style.display = 'flex';
    input.focus();
    const sel = view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
    if (sel) { input.value = sel; findAll(); if (matches.length) goTo(0); }
  }

  function close() {
    bar.style.display = 'none';
    input.value = '';
    matches = [];
    activeIdx = -1;
    view.dispatch({ effects: setSearchQuery.of(null) });
    countEl.textContent = '';
    view.focus();
  }

  const isMacPlatform = /Mac|iPhone|iPad/.test(navigator.platform);
  input.addEventListener('input', () => { findAll(); if (matches.length) goTo(0); });
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    const mod = isMacPlatform ? e.metaKey : e.ctrlKey;
    if (e.key === 'Escape') { close(); e.preventDefault(); }
    else if (e.key === 'g' && mod) { openGotoLine(view); e.preventDefault(); }
    else if (e.key === 's' && mod) { view.dom.dispatchEvent(new CustomEvent('cm-save', { bubbles: true })); e.preventDefault(); }
    else if (e.key === 'Enter' && e.shiftKey) { goTo(activeIdx - 1); e.preventDefault(); }
    else if (e.key === 'Enter') { goTo(activeIdx + 1); e.preventDefault(); }
  });
  (bar.querySelector<HTMLElement>('.terminal-search-next') as HTMLElement).addEventListener('click', () => goTo(activeIdx + 1));
  (bar.querySelector<HTMLElement>('.terminal-search-prev') as HTMLElement).addEventListener('click', () => goTo(activeIdx - 1));
  (bar.querySelector<HTMLElement>('.terminal-search-close') as HTMLElement).addEventListener('click', close);

  return { open, close, bar };
}

const cmFindKeymap = keymap.of([{
  key: 'Mod-f',
  run(view: EditorView) {
    openCMSearch(view);
    return true;
  },
}]);

/** The editor wrapper doubles as the cache for its two floating bars. */
interface BarHost extends HTMLElement {
  _cmSearchBar?: { open(): void; close(): void };
  _cmGotoLine?: { open(): void; close(): void };
}

function openCMSearch(view: EditorView): void {
  const parent = view.dom.parentElement as BarHost | null;
  if (!parent) return;
  // Close goto-line if open
  if (parent._cmGotoLine) parent._cmGotoLine.close();
  if (!parent._cmSearchBar) {
    parent._cmSearchBar = createCMSearchBar(parent, view);
  }
  parent._cmSearchBar.open();
}

// DOM-level Cmd/Ctrl+F listener for read-only editors where CM keymaps don't fire
const cmFindDomHandler = ViewPlugin.fromClass(class {
  _handler: (e: KeyboardEvent) => void;

  constructor(view: EditorView) {
    this._handler = (e: KeyboardEvent) => {
      const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? e.metaKey : e.ctrlKey;
      if (e.key === 'f' && mod && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        openCMSearch(view);
      }
    };
    // Make the wrapper focusable so clicks give it focus
    if (!view.dom.getAttribute('tabindex')) view.dom.setAttribute('tabindex', '0');
    view.dom.addEventListener('keydown', this._handler);
  }
  destroy() {
    // cleanup handled by CM disposing the DOM
  }
});

// ── Go to line (Cmd/Ctrl+G) ──────────────────────────────────────────

function createGotoLineBar(parent: HTMLElement, view: EditorView) {
  const bar = document.createElement('div');
  bar.className = 'terminal-search-bar';
  bar.style.display = 'none';
  bar.innerHTML = `
    <input type="text" class="terminal-search-input" placeholder="Go to line..." style="width:120px" />
    <span class="terminal-search-count"></span>
    <button class="terminal-search-close" title="Close (Escape)">&times;</button>
  `;
  parent.style.position = 'relative';
  parent.appendChild(bar);

  const input = bar.querySelector<HTMLElement>('.terminal-search-input') as HTMLInputElement;
  const countEl = bar.querySelector<HTMLElement>('.terminal-search-count') as HTMLElement;

  function goTo() {
    const lineNum = parseInt(input.value, 10);
    if (!lineNum || lineNum < 1) { countEl.textContent = 'Invalid'; return; }
    const doc = view.state.doc;
    if (lineNum > doc.lines) { countEl.textContent = `Max: ${doc.lines}`; return; }
    const line = doc.line(lineNum);
    view.dispatch({
      selection: { anchor: line.from },
      scrollIntoView: true,
    });
    countEl.textContent = `Line ${lineNum}`;
  }

  function open() {
    bar.style.display = 'flex';
    input.value = '';
    countEl.textContent = `of ${view.state.doc.lines}`;
    input.focus();
  }

  function close() {
    bar.style.display = 'none';
    input.value = '';
    countEl.textContent = '';
    view.focus();
  }

  const isMacPlatform = /Mac|iPhone|iPad/.test(navigator.platform);
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    const mod = isMacPlatform ? e.metaKey : e.ctrlKey;
    if (e.key === 'Escape') { close(); e.preventDefault(); }
    else if (e.key === 'f' && mod) { openCMSearch(view); e.preventDefault(); }
    else if (e.key === 's' && mod) { view.dom.dispatchEvent(new CustomEvent('cm-save', { bubbles: true })); e.preventDefault(); }
    else if (e.key === 'Enter') { goTo(); e.preventDefault(); }
  });
  (bar.querySelector<HTMLElement>('.terminal-search-close') as HTMLElement).addEventListener('click', close);

  return { open, close };
}

function openGotoLine(view: EditorView): void {
  const parent = view.dom.parentElement as BarHost | null;
  if (!parent) return;
  // Close search if open
  if (parent._cmSearchBar) parent._cmSearchBar.close();
  if (!parent._cmGotoLine) {
    parent._cmGotoLine = createGotoLineBar(parent, view);
  }
  parent._cmGotoLine.open();
}

const cmGotoLineKeymap = keymap.of([{
  key: 'Mod-g',
  run(view: EditorView) { openGotoLine(view); return true; },
}]);

// Cmd/Ctrl+S — dispatch custom event so ViewerPanel can handle save
const cmSaveKeymap = keymap.of([{
  key: 'Mod-s',
  run(view: EditorView) {
    view.dom.dispatchEvent(new CustomEvent('cm-save', { bubbles: true }));
    return true;
  },
}]);

const cmGotoLineDomHandler = ViewPlugin.fromClass(class {
  _handler: (e: KeyboardEvent) => void;

  constructor(view: EditorView) {
    this._handler = (e: KeyboardEvent) => {
      const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? e.metaKey : e.ctrlKey;
      if (e.key === 'g' && mod && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        openGotoLine(view);
      }
    };
    view.dom.addEventListener('keydown', this._handler);
  }
  destroy() {}
});

// DOM-level Cmd/Ctrl+S for read-only editors
const cmSaveDomHandler = ViewPlugin.fromClass(class {
  _handler: (e: KeyboardEvent) => void;

  constructor(view: EditorView) {
    this._handler = (e: KeyboardEvent) => {
      const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? e.metaKey : e.ctrlKey;
      if (e.key === 's' && mod && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        view.dom.dispatchEvent(new CustomEvent('cm-save', { bubbles: true }));
      }
    };
    view.dom.addEventListener('keydown', this._handler);
  }
  destroy() {}
});

export function createPlanEditor(parent: HTMLElement) {
  const wrapCompartment = new Compartment();
  const state = EditorState.create({
    doc: '',
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      keymap.of([
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
        ...foldKeymap,
      ]),
      cmFindKeymap,
      cmGotoLineKeymap,
      cmSaveKeymap,
      cmFloatingSearch(),
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      dracula,
      syntaxHighlighting(markdownExtras),
      appThemePatch,
      wrapCompartment.of(EditorView.lineWrapping),
    ],
  });

  const view: WrappableEditorView = new EditorView({ state, parent });
  view._wrapCompartment = wrapCompartment;
  return view;
}

/** An editor carrying the compartment that toggles its line wrapping. */
export interface WrappableEditorView extends EditorView {
  _wrapCompartment?: Compartment;
}

// ── Language Detection ───────────────────────────────────────────────

const LANG_MAP = {
  js: () => javascript(),
  mjs: () => javascript(),
  cjs: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  ts: () => javascript({ typescript: true }),
  mts: () => javascript({ typescript: true }),
  cts: () => javascript({ typescript: true }),
  tsx: () => javascript({ jsx: true, typescript: true }),
  py: () => python(),
  json: () => json(),
  html: () => html(),
  htm: () => html(),
  css: () => css(),
  scss: () => sass(),
  // `.sass` is the indentation-based dialect; `.scss` is the brace-and-semicolon one.
  sass: () => sass({ indented: true }),
  less: () => less(),
  rs: () => rust(),
  go: () => go(),
  java: () => java(),
  xml: () => xml(),
  svg: () => xml(),
  yaml: () => yaml(),
  yml: () => yaml(),
  sql: () => sql(),
  c: () => cpp(),
  cpp: () => cpp(),
  cc: () => cpp(),
  h: () => cpp(),
  hpp: () => cpp(),
  md: () => markdown({ base: markdownLanguage, codeLanguages: languages }),
  mdx: () => markdown({ base: markdownLanguage, codeLanguages: languages }),
};

/**
 * What could be worked out about a file's language.
 *
 * The two halves are separate because they resolve at different speeds:
 * `LANG_MAP` answers synchronously, so the editor can paint highlighted on its
 * first frame, while `@codemirror/language-data` only hands back a description
 * whose parser still has to be imported. First paint must never wait on that
 * import, so the async half is reported on its own and applied once it lands.
 */
export interface ResolvedLanguage {
  /** Usable immediately. `null` means nothing is known, which is plain text. */
  support: LanguageSupport | null;
  /** A language only `language-data` knows, still needing an async `load()`. */
  deferred: LanguageDescription | null;
}

/**
 * Work out how to highlight `filename`.
 *
 * `LANG_MAP` wins wherever it has an entry, because it encodes choices
 * `language-data` cannot make for us: `.ts` as TypeScript rather than plain
 * JavaScript, `.sass` as the indented dialect. Everything it misses is offered
 * to `language-data`, which recognises about a hundred more languages.
 *
 * What neither recognises stays plain text. This used to fall back to markdown,
 * which was actively wrong on source files — every `_name_` came out
 * italicised, `#` comments became headings, and a stylesheet like our own
 * `style.scss` rendered as prose.
 *
 * Exported so anything else that has to highlight a file by name — a static
 * highlighter, say — shares this one table instead of growing a second copy.
 */
export function languageForFilename(filename?: string | null): ResolvedLanguage {
  // Match on the basename: `language-data` recognises whole names as well as
  // extensions (`Dockerfile`, for one) and anchors those patterns, so a leading
  // directory would stop them matching.
  const name = (filename || '').split(/[\\/]/).pop() || '';
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  const factory = ext ? (LANG_MAP as Record<string, () => LanguageSupport>)[ext] : undefined;
  if (factory) return { support: factory(), deferred: null };
  return { support: null, deferred: name ? LanguageDescription.matchFilename(languages, name) : null };
}

/**
 * The slot every upgradeable viewer keeps its language in.
 *
 * One shared instance is enough: a compartment is only an identity key, and
 * each `EditorState` resolves it against its own configuration, so the same
 * compartment addresses whichever view a reconfigure is dispatched to.
 */
const langCompartment = new Compartment();

/**
 * Swap in a language whose parser had to be imported.
 *
 * Deliberately fire-and-forget. The view is already on screen and already
 * readable as plain text, so a slow or failed import costs highlighting and
 * nothing else. Dispatching into a view the user has since closed is safe too —
 * `EditorView.update` stores the state and returns once the view is destroyed.
 *
 * In practice the wait is a microtask: the renderer is bundled as one IIFE with
 * no code splitting, so esbuild has already inlined every parser `languages`
 * can reach and `load()` only hands back what is in memory. The await is still
 * required — that is the contract — but no flash of plain text is expected.
 */
function upgradeLanguage(view: EditorView, resolved: ResolvedLanguage): void {
  const desc = resolved.deferred;
  if (!desc) return;
  void desc.load().then(
    (support) => { view.dispatch({ effects: langCompartment.reconfigure(support) }); },
    () => { /* No parser to be had; plain text is a perfectly good end state. */ },
  );
}

// ── Read-Only File Viewer ───────────────────────────────────────────

export function createReadOnlyViewer(parent: HTMLElement, content: string, filename?: string) {
  const lang = languageForFilename(filename);
  const state = EditorState.create({
    doc: content,
    extensions: [
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      lineNumbers(),
      highlightSpecialChars(),
      foldGutter(),
      bracketMatching(),
      highlightSelectionMatches(),
      keymap.of([...foldKeymap]),
      cmFindKeymap,
      cmFindDomHandler,
      cmGotoLineDomHandler,
      cmSaveDomHandler,
      cmFloatingSearch(),
      langCompartment.of(lang.support ?? []),
      dracula,
      syntaxHighlighting(markdownExtras),
      appThemePatch,
    ],
  });
  const view = new EditorView({ state, parent });
  upgradeLanguage(view, lang);
  return view;
}

// ── Lines the worktree diff attributes to a change ───────────────────

/**
 * The green bars down the gutter of a file opened from the diff.
 *
 * `Diff / File` is a flip *inside* the code half, and a file that arrives with
 * no trace of why you opened it has thrown the diff away — you are reading a
 * whole file with no idea which eight lines of it are new. So the new-side line
 * numbers travel with the open and are painted as a line decoration.
 *
 * A `StateField` rather than a static facet because the buffer is editable:
 * positions have to be mapped through a change, or a keystroke would leave the
 * bars pointing at the wrong lines — or, once a line is deleted, out of the
 * document entirely, which CodeMirror throws on.
 */
const setChangedLines = StateEffect.define<readonly number[]>();

const changedLineMark = Decoration.line({ class: 'cm-changed-line' });

function changedLineDecorations(state: EditorState, lines: readonly number[]): DecorationSet {
  const total = state.doc.lines;
  const marks = [];
  let previous = 0;
  for (const line of lines) {
    // Ascending and de-duplicated: `Decoration.set` requires sorted ranges, and
    // a diff can name the same line twice when two hunks touch.
    if (line <= previous || line < 1 || line > total) continue;
    previous = line;
    marks.push(changedLineMark.range(state.doc.line(line).from));
  }
  return Decoration.set(marks);
}

const changedLineField = StateField.define<DecorationSet>({
  create() { return Decoration.none; },
  update(marks, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setChangedLines)) return changedLineDecorations(tr.state, effect.value);
    }
    return tr.docChanged ? marks.map(tr.changes) : marks;
  },
  provide: field => EditorView.decorations.from(field),
});

/** Mark (or clear, with an empty list) the lines this diff changed. */
export function markChangedLines(view: EditorView, lines: readonly number[]): void {
  view.dispatch({ effects: setChangedLines.of(lines) });
}

// ── Editable File Viewer (for file panel) ───────────────────────────

export function createEditableViewer(
  parent: HTMLElement, content: string, filename?: string,
  { wrap = false, changedLines }: { wrap?: boolean; changedLines?: readonly number[] } = {},
) {
  const lang = languageForFilename(filename);
  const wrapCompartment = new Compartment();

  const state = EditorState.create({
    doc: content,
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      keymap.of([
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
        ...foldKeymap,
      ]),
      cmFindKeymap,
      cmGotoLineKeymap,
      cmSaveKeymap,
      cmFloatingSearch(),
      langCompartment.of(lang.support ?? []),
      dracula,
      syntaxHighlighting(markdownExtras),
      appThemePatch,
      changedLineField,
      wrapCompartment.of(wrap ? EditorView.lineWrapping : []),
    ],
  });

  const view: WrappableEditorView = new EditorView({ state, parent });
  view._wrapCompartment = wrapCompartment;
  upgradeLanguage(view, lang);
  if (changedLines && changedLines.length > 0) markChangedLines(view, changedLines);
  return view;
}

// ── Diff / Merge Viewer ─────────────────────────────────────────────

export function createMergeViewer(
  parent: HTMLElement, originalContent: string, modifiedContent: string, filename?: string,
) {
  // Both merge viewers take only the synchronous half of the resolution. A
  // `MergeView` owns two `EditorState`s, so an async upgrade would have to
  // reconfigure both halves in step, and the unified one has the deletion
  // highlighter reading the language as well. Until that is worth building, a
  // diff of a language only `language-data` knows renders as plain text.
  const langExt = languageForFilename(filename).support ?? [];
  const sharedExts = [
    lineNumbers(),
    highlightSpecialChars(),
    foldGutter(),
    bracketMatching(),
    highlightSelectionMatches(),
    keymap.of([...foldKeymap]),
    cmFindKeymap,
    cmFindDomHandler,
    cmFloatingSearch(),
    langExt,
    dracula,
    syntaxHighlighting(markdownExtras),
    appThemePatch,
  ];

  return new MergeView({
    parent,
    a: {
      doc: originalContent,
      extensions: [
        ...sharedExts,
        EditorView.editable.of(false),
        EditorState.readOnly.of(true),
      ],
    },
    b: {
      doc: modifiedContent,
      extensions: [...sharedExts],
    },
    gutter: true,
    highlightChanges: true,
    collapseUnchanged: { margin: 3, minSize: 4 },
  });
}

export function createUnifiedMergeViewer(
  parent: HTMLElement, originalContent: string, modifiedContent: string, filename?: string,
) {
  // Synchronous only, for the reason given on `createMergeViewer`.
  const langExt = languageForFilename(filename).support ?? [];
  const state = EditorState.create({
    doc: modifiedContent,
    extensions: [
      lineNumbers(),
      highlightSpecialChars(),
      foldGutter(),
      bracketMatching(),
      highlightSelectionMatches(),
      keymap.of([...foldKeymap]),
      cmFindKeymap,
      cmFindDomHandler,
      cmGotoLineDomHandler,
      cmSaveDomHandler,
      cmFloatingSearch(),
      langExt,
      dracula,
      syntaxHighlighting(markdownExtras),
      appThemePatch,
      unifiedMergeView({
        original: originalContent,
        gutter: true,
        highlightChanges: true,
        syntaxHighlightDeletions: true,
        collapseUnchanged: { margin: 3, minSize: 4 },
      }),
    ],
  });
  return new EditorView({ state, parent });
}

// ── Exports ─────────────────────────────────────────────────────────

marked.setOptions({ breaks: true, gfm: true });

export {
  EditorView as CMEditorView,
  EditorState as CMEditorState,
  MergeView as CMMergeView,
  openGotoLine as cmOpenGotoLine,
  marked,
};
