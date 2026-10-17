import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ensureLanguage, highlightLines, highlightSplitRows, highlightUnifiedRows, isLanguageReady, languageFor,
  splitHighlighted, subscribeLanguages,
} from '../src/renderer/ui/session-work/highlight';
import { parseUnifiedDiff } from '../src/domain/session-work/diff';
import { splitRows, unifiedRows } from '../src/domain/session-work/diff-layout';

test('languageFor: by extension, by whole file name, and null for anything else', () => {
  /* Given */
  const cases: Array<[string, string | null, string?]> = [
    ['src/renderer/ui/App.tsx', 'typescript'],
    ['scripts/build.mjs', 'javascript'],
    ['README.MD', 'markdown', 'case does not matter'],
    ['.github/workflows/ci.yml', 'yaml'],
    ['Dockerfile', 'dockerfile'],
    ['docker/Dockerfile.dev', 'dockerfile'],
    ['Makefile', 'makefile'],
    ['Cargo.toml', 'ini'],
    ['LICENSE', null],
    ['assets/logo.png', null],
    ['notes.unknownext', null],
  ];

  for (const [path, expected, why] of cases) {
    /* When */
    const language = languageFor(path);

    /* Then */
    assert.equal(language, expected, why ?? path);
  }
});

test('splitHighlighted closes the spans a line break cuts through and reopens them on the next line', () => {
  /* Given */
  const html = '<span class="hljs-comment">/* one\ntwo */</span> x\n<span class="a"><span class="b">y</span></span>';

  /* When */
  const lines = splitHighlighted(html);

  /* Then */
  assert.deepEqual(lines, [
    '<span class="hljs-comment">/* one</span>',
    '<span class="hljs-comment">two */</span> x',
    '<span class="a"><span class="b">y</span></span>',
  ]);
});

test('splitHighlighted leaves plain text and empty lines as they are', () => {
  /* Given */
  const cases: Array<[string, string[]]> = [
    ['plain', ['plain']],
    ['a\n\nb', ['a', '', 'b']],
  ];

  for (const [html, expected] of cases) {
    /* When */
    const lines = splitHighlighted(html);

    /* Then */
    assert.deepEqual(lines, expected);
  }
});

test('a language is registered on demand, once, and listeners hear about it', async () => {
  /* Given */
  const before = highlightLines(['let a = 1;'], 'rust');
  let heard = 0;
  const unsubscribe = subscribeLanguages(() => heard++);

  /* When */
  const [first, second] = await Promise.all([ensureLanguage('rust'), ensureLanguage('rust')]);
  unsubscribe();

  /* Then */
  assert.equal(before, null, 'not registered yet: plain text');
  assert.deepEqual([first, second], [true, true]);
  assert.equal(heard, 1);
  assert.ok(isLanguageReady('rust'));
});

test('an unknown language never loads', async () => {
  /* When */
  const loaded = await ensureLanguage('klingon');

  /* Then */
  assert.equal(loaded, false, 'an unknown language never loads');
});

test('highlightLines answers one HTML line per text line, escaped, keeping multi-line tokens', async () => {
  /* Given */
  await ensureLanguage('typescript');

  /* When */
  const html = highlightLines(['const a = "<b>";', '/* one', 'two */'], 'typescript')!;

  /* Then */
  assert.equal(html.length, 3);
  assert.match(html[0], /<span class="hljs-keyword">const<\/span>/);
  assert.match(html[0], /&lt;b&gt;/, 'text is escaped');
  assert.match(html[1], /^<span class="hljs-comment">\/\* one<\/span>$/);
  assert.match(html[2], /^<span class="hljs-comment">two \*\/<\/span>$/, 'the comment carries on onto the next line');
});

test('highlightLines answers plain text without a language', () => {
  /* When */
  const html = highlightLines(['x'], null);

  /* Then */
  assert.equal(html, null, 'no language: plain text');
});

test('highlightLines answers nothing for no lines', async () => {
  /* Given */
  await ensureLanguage('typescript');

  /* When */
  const html = highlightLines([], 'typescript');

  /* Then */
  assert.equal(html, null);
});

const DIFF = [
  'diff --git a/a.ts b/a.ts',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,2 +1,2 @@',
  ' const keep = 1;',
  '-let old = "x";',
  '+let now = "y";',
  '',
].join('\n');

test('unified rows are highlighted per side, and a hunk header gets nothing', async () => {
  /* Given */
  await ensureLanguage('typescript');
  const rows = unifiedRows(parseUnifiedDiff(DIFF)[0]);

  /* When */
  const html = highlightUnifiedRows(rows, 0, rows.length, 'typescript')!;

  /* Then */
  assert.equal(html.length, 4);
  assert.equal(html[0], null);
  assert.match(html[1]!, /hljs-keyword">const</);
  assert.match(html[2]!, /hljs-string">&quot;x&quot;</);
  assert.match(html[3]!, /hljs-string">&quot;y&quot;</);
});

test('unified rows highlighted in part count their offsets from the start', async () => {
  /* Given */
  await ensureLanguage('typescript');
  const rows = unifiedRows(parseUnifiedDiff(DIFF)[0]);
  const whole = highlightUnifiedRows(rows, 0, rows.length, 'typescript')!;

  /* When */
  // Only part of the rows: offsets count from `start`.
  const part = highlightUnifiedRows(rows, 2, 4, 'typescript');

  /* Then */
  assert.deepEqual(part, [whole[2], whole[3]]);
});

test('unified rows are not highlighted without a language', () => {
  /* Given */
  const rows = unifiedRows(parseUnifiedDiff(DIFF)[0]);

  /* When */
  const html = highlightUnifiedRows(rows, 0, rows.length, null);

  /* Then */
  assert.equal(html, null);
});

test('split rows are highlighted per side, blank cells staying null', async () => {
  /* Given */
  await ensureLanguage('typescript');
  const rows = splitRows(parseUnifiedDiff(DIFF)[0]);

  /* When */
  const { left, right } = highlightSplitRows(rows, 0, rows.length, 'typescript')!;

  /* Then */
  assert.deepEqual([left.length, right.length], [3, 3]);
  assert.equal(left[0], null, 'the hunk header');
  assert.match(left[2]!, /&quot;x&quot;/);
  assert.match(right[2]!, /&quot;y&quot;/);
});
