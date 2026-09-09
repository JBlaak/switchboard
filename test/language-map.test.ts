import { test } from 'node:test';
import assert from 'node:assert/strict';

import { languageForFilename } from '../src/renderer/lib/codemirror-setup';

// `codemirror-setup` is renderer code, but nothing in it touches the DOM while
// the module is being evaluated — the theme is defined in JS and the one
// `navigator` read lives inside a keydown handler. So the real module imports
// under plain Node and these tests exercise the shipping table rather than a
// copy of it.

/** The language a resolution settled on, or `null` for plain text. */
const nameOf = (filename: string) => languageForFilename(filename).support?.language.name ?? null;

test('TypeScript files resolve to the JavaScript family', () => {
  // `.tsx` reports "typescript" too: lang-javascript names the jsx+ts dialect
  // that way. Either name means the JavaScript parser, which is the point.
  for (const f of ['a.ts', 'a.tsx', 'a.mts', 'a.cts']) {
    assert.equal(nameOf(f), 'typescript', `${f} should be TypeScript`);
  }
  for (const f of ['a.js', 'a.jsx', 'a.mjs', 'a.cjs']) {
    assert.equal(nameOf(f), 'javascript', `${f} should be JavaScript`);
  }
});

test('stylesheet dialects resolve to their own languages, not markdown', () => {
  // The bug this guards: `style.scss` used to fall through to the markdown
  // fallback and render the app's own stylesheet as prose.
  assert.equal(nameOf('style.scss'), 'sass');
  assert.equal(nameOf('style.sass'), 'sass');
  assert.equal(nameOf('style.less'), 'less');
  assert.equal(nameOf('style.css'), 'css');
  for (const f of ['style.scss', 'style.sass', 'style.less']) {
    assert.notEqual(nameOf(f), 'markdown', `${f} must not be markdown`);
  }
});

test('.sass gets the indented dialect and .scss does not', () => {
  // Both report the name "sass", so the only honest check is behavioural:
  // brace-less source is valid sass and invalid scss.
  const indentedSource = 'nav\n  ul\n    margin: 0\n';
  const errorCount = (filename: string) => {
    const support = languageForFilename(filename).support;
    assert.ok(support, `${filename} should resolve`);
    let errors = 0;
    support.language.parser.parse(indentedSource).iterate({
      enter: (node) => { if (node.type.isError) errors++; },
    });
    return errors;
  };
  assert.equal(errorCount('a.sass'), 0, 'indented sass should parse cleanly');
  assert.ok(errorCount('a.scss') > 0, 'scss should reject brace-less source');
});

test('markdown is still markdown', () => {
  assert.equal(nameOf('README.md'), 'markdown');
  assert.equal(nameOf('page.mdx'), 'markdown');
});

test('an unknown extension is plain text and does not throw', () => {
  for (const f of ['weird.xyz', 'noextension', 'archive.tar.zzz', '']) {
    const resolved = languageForFilename(f);
    assert.equal(resolved.support, null, `${f} should be plain text`);
    assert.equal(resolved.deferred, null, `${f} should have nothing to load`);
  }
  // The absent-filename callers (a scratch buffer, an unsaved file) go the
  // same way rather than guessing markdown at them.
  assert.deepEqual(languageForFilename(undefined), { support: null, deferred: null });
  assert.deepEqual(languageForFilename(null), { support: null, deferred: null });
});

test('language-data covers extensions the map does not', () => {
  // Neither is in LANG_MAP, so both prove the second lookup runs.
  for (const f of ['Cargo.toml', 'App.swift']) {
    const resolved = languageForFilename(f);
    assert.equal(resolved.support, null, `${f} has no synchronous support`);
    assert.ok(resolved.deferred, `${f} should be recognised by language-data`);
  }
  assert.equal(languageForFilename('Cargo.toml').deferred?.name, 'TOML');
  assert.equal(languageForFilename('App.swift').deferred?.name, 'Swift');
});

test('a deferred description loads into a real language', async () => {
  const { deferred } = languageForFilename('Cargo.toml');
  assert.ok(deferred);
  const support = await deferred.load();
  assert.equal(support.language.name, 'toml');
});

test('a path is matched on its basename', () => {
  // `matchFilename` anchors whole-name patterns, so a leading directory would
  // stop them matching; and a dot in a directory name must not be read as the
  // file's extension.
  assert.equal(nameOf('src/renderer/styles/style.scss'), 'sass');
  assert.equal(nameOf('C:\\app\\src\\style.scss'), 'sass');
  assert.equal(nameOf('some.dir/plainfile'), null);
  assert.equal(languageForFilename('build/docker/Dockerfile').deferred?.name, 'Dockerfile');
});
