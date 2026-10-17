import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ensureLanguage, highlightLines, highlightSplitRows, highlightUnifiedRows, isLanguageReady, languageFor,
  splitHighlighted, subscribeLanguages,
} from '../src/renderer/ui/session-work/highlight';
import { parseUnifiedDiff } from '../src/domain/session-work/diff';
import { splitRows, unifiedRows } from '../src/domain/session-work/diff-layout';

test('languageFor: by extension, by whole file name, and null for anything else', () => {
  assert.equal(languageFor('src/renderer/ui/App.tsx'), 'typescript');
  assert.equal(languageFor('scripts/build.mjs'), 'javascript');
  assert.equal(languageFor('README.MD'), 'markdown', 'case does not matter');
  assert.equal(languageFor('.github/workflows/ci.yml'), 'yaml');
  assert.equal(languageFor('Dockerfile'), 'dockerfile');
  assert.equal(languageFor('docker/Dockerfile.dev'), 'dockerfile');
  assert.equal(languageFor('Makefile'), 'makefile');
  assert.equal(languageFor('Cargo.toml'), 'ini');
  assert.equal(languageFor('LICENSE'), null);
  assert.equal(languageFor('assets/logo.png'), null);
  assert.equal(languageFor('notes.unknownext'), null);
});

test('splitHighlighted closes the spans a line break cuts through and reopens them on the next line', () => {
  const html = '<span class="hljs-comment">/* one\ntwo */</span> x\n<span class="a"><span class="b">y</span></span>';
  assert.deepEqual(splitHighlighted(html), [
    '<span class="hljs-comment">/* one</span>',
    '<span class="hljs-comment">two */</span> x',
    '<span class="a"><span class="b">y</span></span>',
  ]);
  assert.deepEqual(splitHighlighted('plain'), ['plain']);
  assert.deepEqual(splitHighlighted('a\n\nb'), ['a', '', 'b']);
});

test('a language is registered on demand, once, and listeners hear about it', async () => {
  assert.equal(highlightLines(['let a = 1;'], 'rust'), null, 'not registered yet: plain text');
  let heard = 0;
  const unsubscribe = subscribeLanguages(() => heard++);
  const [first, second] = await Promise.all([ensureLanguage('rust'), ensureLanguage('rust')]);
  unsubscribe();
  assert.deepEqual([first, second], [true, true]);
  assert.equal(heard, 1);
  assert.ok(isLanguageReady('rust'));
  assert.equal(await ensureLanguage('klingon'), false, 'an unknown language never loads');
});

test('highlightLines answers one HTML line per text line, escaped, keeping multi-line tokens', async () => {
  await ensureLanguage('typescript');
  const html = highlightLines(['const a = "<b>";', '/* one', 'two */'], 'typescript')!;
  assert.equal(html.length, 3);
  assert.match(html[0], /<span class="hljs-keyword">const<\/span>/);
  assert.match(html[0], /&lt;b&gt;/, 'text is escaped');
  assert.match(html[1], /^<span class="hljs-comment">\/\* one<\/span>$/);
  assert.match(html[2], /^<span class="hljs-comment">two \*\/<\/span>$/, 'the comment carries on onto the next line');
  assert.equal(highlightLines(['x'], null), null, 'no language: plain text');
  assert.equal(highlightLines([], 'typescript'), null);
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
  await ensureLanguage('typescript');
  const rows = unifiedRows(parseUnifiedDiff(DIFF)[0]);
  const html = highlightUnifiedRows(rows, 0, rows.length, 'typescript')!;
  assert.equal(html.length, 4);
  assert.equal(html[0], null);
  assert.match(html[1]!, /hljs-keyword">const</);
  assert.match(html[2]!, /hljs-string">&quot;x&quot;</);
  assert.match(html[3]!, /hljs-string">&quot;y&quot;</);
  // Only part of the rows: offsets count from `start`.
  assert.deepEqual(highlightUnifiedRows(rows, 2, 4, 'typescript'), [html[2], html[3]]);
  assert.equal(highlightUnifiedRows(rows, 0, rows.length, null), null);
});

test('split rows are highlighted per side, blank cells staying null', async () => {
  await ensureLanguage('typescript');
  const rows = splitRows(parseUnifiedDiff(DIFF)[0]);
  const { left, right } = highlightSplitRows(rows, 0, rows.length, 'typescript')!;
  assert.deepEqual([left.length, right.length], [3, 3]);
  assert.equal(left[0], null, 'the hunk header');
  assert.match(left[2]!, /&quot;x&quot;/);
  assert.match(right[2]!, /&quot;y&quot;/);
});
