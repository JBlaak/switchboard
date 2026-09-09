import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { highlightTree, classHighlighter } from '@lezer/highlight';
import { draculaHighlightStyle, config } from '@ddietr/codemirror-themes/theme/dracula';

import {
  highlightLine,
  highlightLines,
  highlightLanguageFor,
  loadHighlightLanguage,
  MAX_HIGHLIGHT_LINES,
  MAX_HIGHLIGHT_LINE_LENGTH,
} from '../src/renderer/lib/highlight-static';

// `highlight-static` reaches `codemirror-setup` for the language table, and
// nothing on that path touches the DOM at module scope — the same property
// test/language-map.test.ts relies on. So these tests exercise the shipping
// module rather than a copy of it.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stylesheet = path.join(root, 'src/renderer/styles/_code-highlight.scss');

const ts = highlightLanguageFor('a.ts');
const scss = highlightLanguageFor('style.scss');
const md = highlightLanguageFor('README.md');

/** Every class on every span of a rendered line. */
function classesOf(html: string): string[] {
  return [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(' '));
}

/** The text a browser would show, with the spans stripped and entities undone. */
function textOf(html: string): string {
  return html
    .replace(/<\/?span[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

// ── Colouring ────────────────────────────────────────────────────────

test('a TypeScript line marks its keyword and its string literal', () => {
  const html = highlightLine('const greeting = "hello";', ts);
  assert.match(html, /<span class="tok-keyword">const<\/span>/);
  assert.match(html, /<span class="tok-string">&quot;hello&quot;<\/span>/);
});

test('SCSS is coloured, and not the way markdown would colour it', () => {
  // The M2 bug this pairs with: `style.scss` used to fall through to the
  // markdown fallback and render the app's own stylesheet as prose.
  const line = '$brand: #69e2bf;';
  const asScss = highlightLine(line, scss);
  const asMarkdown = highlightLine(line, md);

  assert.ok(classesOf(asScss).length > 0, 'SCSS should produce spans');
  assert.notEqual(asScss, asMarkdown, 'SCSS must not render the same as markdown');
  // Markdown finds no structure in a declaration at all, which is precisely why
  // it was the wrong fallback: the stylesheet came out as flat prose.
  assert.equal(asMarkdown, '$brand: #69e2bf;');
  assert.ok(classesOf(asScss).includes('tok-variableName2'), '$brand is a sass variable');
});

test('a resolved language reports the parser it will use', () => {
  assert.equal(ts?.name, 'typescript');
  assert.equal(scss?.name, 'sass');
  assert.equal(highlightLanguageFor('mystery.xyz'), null);
});

test('a language only language-data knows can be awaited into place', async () => {
  // The synchronous door says no, so a diff scroll being built right now gets
  // plain text; a caller that can await gets the parser.
  assert.equal(highlightLanguageFor('Cargo.toml'), null);
  const toml = await loadHighlightLanguage('Cargo.toml');
  assert.equal(toml?.name, 'toml');
  assert.equal(await loadHighlightLanguage('mystery.xyz'), null);
});

// ── Escaping ─────────────────────────────────────────────────────────

test('markup inside a string literal comes back escaped', () => {
  const html = highlightLine('const tag = "<script>alert(1)</script>";', ts);
  assert.ok(!html.includes('<script'), 'a raw <script must never survive');
  assert.ok(!html.includes('</script>'), 'nor its closing tag');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  // The only `<` left in the output belongs to spans this module wrote.
  for (const fragment of html.split('<span class="tok-')) {
    assert.ok(!fragment.replace(/^[^>]*>/, '').split('</span>')[0].includes('<'));
  }
});

test('ampersands and angle brackets in ordinary code survive as entities', () => {
  const html = highlightLine('if (a < b && c > d) return;', ts);
  assert.match(html, /&lt;/);
  assert.match(html, /&amp;&amp;/);
  assert.match(html, /&gt;/);
  // Round-tripping the entities gets the source back, character for character.
  assert.equal(textOf(html), 'if (a < b && c > d) return;');
});

test('a line with no language is escaped and carries no spans', () => {
  const html = highlightLine('<b>&amp;</b> if (x < 1)', null);
  assert.equal(classesOf(html).length, 0);
  assert.ok(!html.includes('<b>'));
  assert.equal(html, '&lt;b&gt;&amp;amp;&lt;/b&gt; if (x &lt; 1)');
});

test('escaping happens in the gaps between spans too', () => {
  // The whitespace and operators between tokens are a separate code path from
  // the token text, and an un-escaped gap is just as much an injection.
  const html = highlightLine('const x = a < b;', ts);
  assert.equal(textOf(html), 'const x = a < b;');
});

// ── Guards ───────────────────────────────────────────────────────────

test('a block past the line cap comes back unparsed but escaped', () => {
  const lines = Array.from({ length: MAX_HIGHLIGHT_LINES + 1000 }, (_, i) => `const v${i} = "<${i}>";`);
  const started = performance.now();
  const out = highlightLines(lines, ts);
  const elapsed = performance.now() - started;

  assert.equal(out.length, lines.length);
  assert.equal(classesOf(out.join('')).length, 0, 'the guard should have skipped parsing');
  assert.ok(!out.join('').includes('<span'), 'no spans at all');
  assert.match(out[0], /&lt;0&gt;/, 'still escaped');
  // A minified bundle must never lock the renderer. The real work here is one
  // pass of String.replace, so a whole frame is a generous ceiling.
  assert.ok(elapsed < 16, `guarded path took ${elapsed.toFixed(1)}ms`);
});

test('one over-long line turns colouring off for the whole call', () => {
  const long = `const x = "${'a'.repeat(MAX_HIGHLIGHT_LINE_LENGTH + 3000)}"; // <b>`;
  const started = performance.now();
  const out = highlightLines(['const y = 1;', long], ts);
  const elapsed = performance.now() - started;

  assert.equal(out.length, 2);
  assert.equal(classesOf(out.join('')).length, 0, 'the guard should have skipped parsing');
  assert.match(out[1], /&lt;b&gt;$/, 'still escaped');
  assert.ok(elapsed < 16, `guarded path took ${elapsed.toFixed(1)}ms`);
});

test('a block just inside the caps is still coloured', () => {
  // Guards that fire early would quietly turn highlighting off everywhere.
  const out = highlightLines(Array.from({ length: MAX_HIGHLIGHT_LINES }, () => 'const a = 1;'), ts);
  assert.ok(classesOf(out.join('')).length > 0);
  assert.ok(classesOf(highlightLine(`const s = "${'a'.repeat(MAX_HIGHLIGHT_LINE_LENGTH - 20)}";`, ts)).length > 0);
});

// ── Shape ────────────────────────────────────────────────────────────

test('highlightLines returns one entry per line, trailing empties included', () => {
  const lines = ['const a = 1;', '', 'const b = 2;', '', ''];
  const out = highlightLines(lines, ts);
  assert.equal(out.length, lines.length);
  assert.equal(out[1], '');
  assert.equal(out[3], '');
  assert.equal(out[4], '');
  assert.match(out[2], /tok-keyword/);

  // The same holds with no language and with nothing at all.
  assert.equal(highlightLines(lines, null).length, lines.length);
  assert.deepEqual(highlightLines([], ts), []);
  assert.deepEqual(highlightLines([''], ts), ['']);
});

test('a block is parsed as one document, so multi-line constructs hold', () => {
  const out = highlightLines(['/* opens here', '   keeps going', '   closes */ const x = 1;'], ts);
  assert.match(out[1], /tok-comment/, 'the middle of a block comment is comment');
  assert.match(out[2], /tok-keyword/, 'and code after the close is code again');
});

test('a line torn out of its block loses that context — the documented limit', () => {
  // Not a wish, a warning: this is why highlightLines takes a block and why the
  // diff view should pass the largest chunk it has.
  assert.ok(!highlightLine('   keeps going', ts).includes('tok-comment'));
});

// ── The stylesheet cannot drift from the theme ───────────────────────

/** `class → colour`, read out of the SCSS the app actually ships. */
function stylesheetColours(): Map<string, string> {
  const css = fs.readFileSync(stylesheet, 'utf8');
  const colours = new Map<string, string>();
  // Selectors accumulate across lines, because the file groups them one per
  // line above a shared declaration.
  let pending: string[] = [];
  for (const raw of css.split('\n')) {
    const line = raw.replace(/\/\*.*?\*\//g, '').trim();
    if (!line || line.startsWith('/*') || line.startsWith('*')) continue;
    for (const cls of line.matchAll(/\.(tok-[A-Za-z0-9]+)/g)) pending.push(cls[1]);
    const decl = line.match(/color:\s*(#[0-9A-Fa-f]{3,8})\s*;/);
    if (decl) for (const cls of pending) colours.set(cls, decl[1].toUpperCase());
    if (line.includes('}')) pending = [];
  }
  return colours;
}

test('every hex in _code-highlight.scss still equals the config key it names', () => {
  // SCSS cannot import a JS object, so the mapping is written out by hand with
  // the `config` key named in a comment beside it. This is what keeps those
  // comments true: bump @ddietr/codemirror-themes and this test says so.
  const css = fs.readFileSync(stylesheet, 'utf8');
  const annotated = [...css.matchAll(/(#[0-9A-Fa-f]{3,8})\s*;?\s*(?:[^\n]*?)\/\*\s*config\.([A-Za-z]+)\s*\*\//g)];
  assert.ok(annotated.length >= 12, `expected the whole table to be annotated, found ${annotated.length}`);

  for (const [, hex, key] of annotated) {
    const expected = (config as Record<string, unknown>)[key];
    assert.equal(typeof expected, 'string', `config.${key} does not exist`);
    assert.equal(hex.toUpperCase(), String(expected).toUpperCase(), `config.${key} has moved`);
  }

  // And every declaration carrying a hex value has one of those annotations,
  // so no colour can be added to the file without being checked. Comments are
  // stripped first, because the prose in this file quotes hex values too.
  const declared = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/:\s*#[0-9A-Fa-f]{3,8}\s*;/g)].length;
  assert.equal(declared, annotated.length, 'a colour was added without naming its config key');
});

test('the static classes land on the colours the live editor would use', () => {
  // The strongest version of "the two surfaces cannot drift": colour real
  // snippets both ways and compare token by token. Anything the stylesheet has
  // no rule for falls back to the page foreground, which is what a browser
  // would do, and dracula's own unstyled tokens do the same in the editor.
  const table = stylesheetColours();
  const foreground = config.foreground.toUpperCase();
  const editorRules = (draculaHighlightStyle as unknown as { module: { getRules(): string } }).module.getRules().split('\n');

  const editorColour = (generated: string): string => {
    for (const part of generated.split(' ')) {
      for (const rule of editorRules) {
        if (!rule.includes(`.${part}{`) && !rule.includes(`.${part},`) && !rule.includes(`.${part} `)) continue;
        const m = rule.match(/color:\s*(#[0-9A-Fa-f]{3,8})/);
        if (m) return m[1].toUpperCase();
      }
    }
    return foreground;
  };

  const samples: Array<[string, string]> = [
    ['a.ts', 'const n = 1;\nfunction f(x: string) { return `a${x}` /* c */; }\nenum E { A }'],
    ['style.scss', '$brand: #69e2bf;\n.a { padding: 10px; color: red; }\n@mixin m($x: 1) { width: $x * 100%; }'],
    ['a.json', '{"a": 1, "b": [true, null]}'],
    ['a.py', 'def f(x):\n    return "s"  # note'],
  ];

  // The one place the two genuinely cannot agree. `classHighlighter` has a
  // coarser vocabulary than the editor's HighlightStyle: a plain variable, a
  // called function and a constant all arrive as `tok-variableName`, where
  // dracula paints them white, green and purple. The static surface reads as
  // the same theme, not as a pixel copy — see _code-highlight.scss.
  const coarse = new Set(['tok-variableName', 'tok-variableName2']);

  for (const [filename, code] of samples) {
    const lang = highlightLanguageFor(filename);
    assert.ok(lang, `${filename} should resolve`);
    const tree = lang.parser.parse(code);

    const staticClass = new Map<string, string>();
    const editorClass = new Map<string, string>();
    highlightTree(tree, classHighlighter, (from, to, cls) => staticClass.set(`${from}:${to}`, cls));
    highlightTree(tree, draculaHighlightStyle, (from, to, cls) => editorClass.set(`${from}:${to}`, cls));

    for (const [range, cls] of staticClass) {
      const first = cls.split(' ')[0];
      if (coarse.has(first)) continue;
      const mine = table.get(first) ?? foreground;
      const theirs = editorColour(editorClass.get(range) ?? '');
      const [from, to] = range.split(':').map(Number);
      assert.equal(mine, theirs, `${filename}: ${JSON.stringify(code.slice(from, to))} (${first})`);
    }
  }
});
