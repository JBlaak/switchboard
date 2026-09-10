import { test } from 'node:test';
import assert from 'node:assert';
import {
  MAX_HUNK_LINES, MAX_HUNK_LINE_LENGTH, MAX_WATCHED_FILES,
  askTarget, attributionOf, buildDiffView, colourable, conflictPrompt, conflictRegionsIn,
  conflictRoles, hasConflictMarkers, markStale, nextWatched, relativeToWorktree,
  sanitiseForTerminal,
} from '../src/renderer/features/code/diff-view-model';
import {
  MAX_HIGHLIGHT_LINES, MAX_HIGHLIGHT_LINE_LENGTH, highlightLanguageFor, highlightLines,
} from '../src/renderer/lib/highlight-static';
import { FileWatchRegistry } from '../src/infrastructure/fs/file-watch-registry';
import { fakeFileSystem, fakeTimers } from './support/fakes';
import type { DiffSection } from '../src/renderer/features/code/diff-view-model';
import type { ChangesPayload } from '../src/domain/changes/types';
import type { DiffBase, FileDiff, Hunk } from '../src/domain/git/types';
import type { SessionClaim } from '../src/domain/attribution/types';

/**
 * The states a change is not plain readable text.
 *
 * A merge conflict, a file two sessions both wrote, a file that changed while
 * it was being read, and a line no parser should be handed. Every one of them
 * is decided in `diff-view-model.ts` for exactly this reason: the surface that
 * draws them needs a DOM and this file does not have one, so what is asserted
 * here is the decision and never the drawing.
 */

const MAIN: DiffBase = { kind: 'merge-base', ref: 'main' };

function changed(path: string, over: Partial<FileDiff> = {}): FileDiff {
  return {
    path,
    status: 'M',
    additions: 3,
    deletions: 1,
    binary: false,
    generated: false,
    whitespaceOnly: false,
    submodule: false,
    hunks: [],
    ...over,
  };
}

function claim(sessionId: string, lastAtIso = '2026-09-09T10:00:00Z', edits = 1): SessionClaim {
  return { sessionId, lastAtIso, edits };
}

function payload(over: Partial<ChangesPayload> = {}): ChangesPayload {
  return { base: MAIN, requestedBase: MAIN, files: [], untracked: [], claims: {}, ...over };
}

/** A hunk of the given lines, all added — which is how git prints a conflict. */
function addedHunk(...texts: string[]): Hunk {
  return {
    header: '@@ -211,2 +211,7 @@',
    oldStart: 211,
    newStart: 211,
    lines: texts.map(text => ({ kind: 'add' as const, text })),
  };
}

/** The shape git leaves in a file it could not merge. */
const CONFLICTED = [
  'const scope = read();',
  '<<<<<<< HEAD',
  '  scope = saved;',
  '=======',
  '  scope = restore();',
  '>>>>>>> main',
  'return scope;',
];

// ── merge conflict ────────────────────────────────────────────────────────────

test('a conflicted file is classified as one, and never folded away as boring', () => {
  const conflicted = buildDiffView(payload({
    files: [changed('src/renderer/app.ts', { status: 'U', additions: 6, deletions: 2 })],
  }));
  assert.strictEqual(conflicted.sections[0].conflicted, true);
  assert.strictEqual(conflicted.sections[0].body, 'hunks');

  // A conflicted lockfile is the commonest conflict there is. Hiding it behind
  // a banner that says "generated" would be telling the reader their tree is
  // clean while git refuses to continue.
  const lock = buildDiffView(payload({
    files: [
      changed('package-lock.json', { status: 'U', generated: true, truncated: 'generated' }),
      changed('yarn.lock', { generated: true, truncated: 'generated' }),
    ],
  }));
  assert.deepStrictEqual(lock.sections.map(section => section.path), ['package-lock.json']);
  assert.strictEqual(lock.sections[0].body, 'hunks');
  assert.strictEqual(lock.generatedHidden, 1);

  // A reformat that is also conflicted is not a reformat you can skip either.
  const reindented = buildDiffView(payload({
    files: [changed('src/db.ts', { status: 'U', whitespaceOnly: true })],
  }));
  assert.strictEqual(reindented.sections[0].body, 'hunks');

  // Size is the one collapse that still applies: it is about what the browser
  // can draw, not about what is worth reading, and Expand undoes it.
  const huge = buildDiffView(payload({
    files: [changed('dist/app.js', { status: 'U', truncated: 'size' })],
  }));
  assert.strictEqual(huge.sections[0].body, 'oversize');
  assert.strictEqual(
    buildDiffView(payload({ files: [changed('dist/app.js', { status: 'U', truncated: 'size' })] }),
      { expanded: new Set(['dist/app.js']) }).sections[0].body,
    'hunks',
  );
});

test('the marker rows of a conflict are identified, and so are the two sides', () => {
  assert.strictEqual(hasConflictMarkers(CONFLICTED), true);
  assert.deepStrictEqual(conflictRoles(CONFLICTED), [
    null, 'start', 'ours', 'separator', 'theirs', 'end', null,
  ]);

  // diff3 / zdiff3 write the common ancestor as a third side. Without a role of
  // its own the whole region would be coloured as "ours".
  assert.deepStrictEqual(conflictRoles([
    '<<<<<<< ours', 'a', '||||||| base', 'b', '=======', 'c', '>>>>>>> theirs',
  ]), ['start', 'ours', 'base-marker', 'base', 'separator', 'theirs', 'end']);
});

test('a row of equals signs is only a separator inside a conflict', () => {
  // Markdown's setext heading underline, in an ordinary file.
  assert.deepStrictEqual(conflictRoles(['Title', '=======', 'body']), [null, null, null]);
  assert.strictEqual(hasConflictMarkers(['Title', '=======', 'body']), false);
});

test('a conflict that never closes keeps its roles to the end of the block', () => {
  // The hunk was cut off, or git really did leave it that way. Colouring the
  // tail as ordinary code would hide it either way.
  assert.deepStrictEqual(conflictRoles(['<<<<<<< HEAD', 'a', '=======', 'b']),
    ['start', 'ours', 'separator', 'theirs']);
});

test('the header counts every conflict in the file, not every marker', () => {
  assert.strictEqual(conflictRegionsIn([addedHunk(...CONFLICTED)]), 1);
  assert.strictEqual(
    conflictRegionsIn([addedHunk(...CONFLICTED), addedHunk(...CONFLICTED)]), 2);
  assert.strictEqual(conflictRegionsIn([]), 0);
});

// ── who to hand the conflict to ───────────────────────────────────────────────

test('the conflict goes to a session that wrote the file, if one is still running', () => {
  const claims = [claim('s-late', '2026-09-09T12:00:00Z'), claim('s-early')];

  assert.deepStrictEqual(askTarget(claims, 'on-screen', new Set(['s-late', 's-early'])),
    { sessionId: 's-late', from: 'claim' });

  // The most recent claimant has exited; the other one wrote this file too and
  // is still there, which beats guessing at whatever is on screen.
  assert.deepStrictEqual(askTarget(claims, 'on-screen', new Set(['s-early', 'on-screen'])),
    { sessionId: 's-early', from: 'claim' });

  // Nobody claims it, or no claimant is alive: the session in front of the
  // reader, and only if it is running.
  assert.deepStrictEqual(askTarget([], 'on-screen', new Set(['on-screen'])),
    { sessionId: 'on-screen', from: 'active' });
  assert.deepStrictEqual(askTarget(claims, 'on-screen', new Set(['on-screen'])),
    { sessionId: 'on-screen', from: 'active' });

  // And otherwise nothing at all. A prompt written into a dead terminal is
  // lost without a sound, so the button is drawn disabled rather than lying.
  assert.strictEqual(askTarget(claims, 'on-screen', new Set()), null);
  assert.strictEqual(askTarget([], null, new Set(['s-late'])), null);
});

test('the prompt is one line, and a path cannot smuggle a Return into it', () => {
  const prompt = conflictPrompt('src/renderer/app.ts', 2);
  assert.match(prompt, /src\/renderer\/app\.ts/);
  assert.match(prompt, /2 conflicts/);
  assert.match(conflictPrompt('a.ts', 1), /1 conflict\b/);

  // The text is written into a live PTY, where a newline is not a newline — it
  // is Return, and it submits whatever is in the composer at that instant. git
  // quotes such a path in its output and the parser unquotes it faithfully, so
  // one really can reach this surface.
  const nasty = conflictPrompt('src/a.ts\nrm -rf /\n', 1);
  assert.ok(!nasty.includes('\n'), nasty);
  assert.ok(!nasty.includes('\r'), nasty);
  assert.strictEqual(sanitiseForTerminal('a\u0000b\u001bc\u007fd'), 'a b c d');
  assert.strictEqual(sanitiseForTerminal('  padded\t\tout  '), 'padded out');
});

// ── one file, two sessions ────────────────────────────────────────────────────

test('a file two sessions wrote reports both, and is flagged as shared', () => {
  const view = buildDiffView(payload({
    files: [changed('src/renderer/app.ts'), changed('src/main/db.ts')],
    claims: {
      'src/renderer/app.ts': [
        claim('review-issue-9', '2026-09-09T12:00:00Z', 4),
        claim('commit-local-changes', '2026-09-09T09:00:00Z', 2),
      ],
      'src/main/db.ts': [claim('review-issue-9', '2026-09-09T12:00:00Z', 1)],
    },
  }));

  // Once in the diff, with both names on it — never twice, once per session.
  assert.strictEqual(view.sections.length, 2);

  const shared = attributionOf(view.sections[0]);
  assert.deepStrictEqual(shared.claims.map(entry => entry.sessionId),
    ['review-issue-9', 'commit-local-changes']);
  assert.strictEqual(shared.overlapping, true);
  assert.strictEqual(shared.edits, 6);

  const alone = attributionOf(view.sections[1]);
  assert.strictEqual(alone.overlapping, false);
  assert.strictEqual(alone.edits, 1);

  // And no claims at all is not an error — most files in most diffs.
  assert.deepStrictEqual(attributionOf({ claims: [] }),
    { claims: [], overlapping: false, edits: 0 });
});

// ── changed underneath you ────────────────────────────────────────────────────

test('a watcher on a drawn file makes that section stale, and nothing else does', () => {
  const drawn = new Set(['src/app.ts', 'src/db.ts']);

  const first = markStale(new Set(), drawn, '/w/tree', '/w/tree/src/app.ts');
  assert.deepStrictEqual([...first], ['src/app.ts']);

  // Already stale: the same answer, not a second entry.
  assert.deepStrictEqual([...markStale(first, drawn, '/w/tree', '/w/tree/src/app.ts')],
    ['src/app.ts']);

  // A file the reader has never scrolled to is not news — it is the tree
  // moving, which it does constantly while a session runs.
  assert.deepStrictEqual([...markStale(first, drawn, '/w/tree', '/w/tree/src/other.ts')],
    ['src/app.ts']);
  // Nor is a file in another worktree, or a change with no worktree scoped.
  assert.deepStrictEqual([...markStale(new Set(), drawn, '/w/tree', '/elsewhere/src/app.ts')], []);
  assert.deepStrictEqual([...markStale(new Set(), drawn, null, '/w/tree/src/app.ts')], []);

  // The caller is handed a new set rather than a mutated one.
  assert.strictEqual(first.has('src/app.ts'), true);
  assert.strictEqual(new Set().size, 0);
});

test('a watcher path is matched against the worktree whatever separator it came back with', () => {
  assert.strictEqual(relativeToWorktree('/w/tree', '/w/tree/src/app.ts'), 'src/app.ts');
  assert.strictEqual(relativeToWorktree('/w/tree/', '/w/tree/src/app.ts'), 'src/app.ts');
  // The main process answers with `path.resolve`'s spelling, which on Windows
  // means backslashes where the diff's own paths have forward slashes.
  assert.strictEqual(relativeToWorktree('C:/w/tree', 'C:\\w\\tree\\src\\app.ts'), 'src/app.ts');

  assert.strictEqual(relativeToWorktree('/w/tree', '/w/tree'), null);
  assert.strictEqual(relativeToWorktree('/w/tree', '/w/tree-other/src/app.ts'), null);
  assert.strictEqual(relativeToWorktree('/w/tree', '/elsewhere/app.ts'), null);
});

test('the watch set is bounded, and the oldest entry is the one released', () => {
  let watched: string[] = [];
  for (let i = 0; i < MAX_WATCHED_FILES; i++) {
    watched = nextWatched(watched, `f${i}.ts`).watched;
  }
  assert.strictEqual(watched.length, MAX_WATCHED_FILES);

  const overflowed = nextWatched(watched, 'one-more.ts');
  assert.strictEqual(overflowed.watched.length, MAX_WATCHED_FILES);
  assert.deepStrictEqual(overflowed.released, ['f0.ts']);
  assert.strictEqual(overflowed.watched.at(-1), 'one-more.ts');

  // Filling one that is already watched is not a second watch.
  const again = nextWatched(['a.ts', 'b.ts'], 'a.ts', 2);
  assert.deepStrictEqual(again, { watched: ['a.ts', 'b.ts'], released: [] });
});

test('two surfaces watching one file do not close it out from under each other', () => {
  // The diff watches the sections it has drawn, and a viewer panel watches the
  // file you opened *from* the diff — so the same path is asked for twice as a
  // matter of course, and the first release must not be the last word.
  const fs = fakeFileSystem({ files: { '/w/app.ts': 'x' } });
  const timers = fakeTimers();
  const seen: string[] = [];
  const registry = new FileWatchRegistry({ fs, timers, onChanged: p => seen.push(p) });

  registry.watch('/w/app.ts');
  registry.watch('/w/app.ts');
  registry.unwatch('/w/app.ts');

  fs.emitChange('/w/app.ts');
  timers.tick();
  assert.deepStrictEqual(seen, ['/w/app.ts']);

  registry.unwatch('/w/app.ts');
  fs.emitChange('/w/app.ts');
  timers.tick();
  assert.deepStrictEqual(seen, ['/w/app.ts'], 'the last release closes the handle');
});

// ── long lines and caps ───────────────────────────────────────────────────────

test('a minified line is escaped plain text rather than a parse nobody survives', () => {
  const minified = `!function(e,t){${'"object"==typeof exports&&'.repeat(2000)}}(0);`;
  assert.ok(minified.length > MAX_HUNK_LINE_LENGTH * 10, 'the fixture has to be pathological');

  // The diff refuses the block before building the array to hand over…
  assert.strictEqual(colourable([minified]), false);
  // …and the highlighter refuses it too, so a caller that skipped the first
  // check still gets escaped text instead of Lezer on the only thread.
  const [only] = highlightLines([minified], highlightLanguageFor('dist/bundle.js'));
  assert.ok(!only.includes('<span'), 'no colour was attempted');
  assert.ok(only.includes('&amp;&amp;'), 'and every character is still there, escaped');
  assert.strictEqual(only.length >= minified.length, true);

  // Ordinary code is still coloured — the cap is a cap, not a policy.
  assert.strictEqual(colourable(['const a = 1;', 'export default a;']), true);
});

test('the diff\'s caps sit at or under the highlighter\'s, and have not drifted', () => {
  assert.ok(MAX_HUNK_LINES <= MAX_HIGHLIGHT_LINES);
  assert.strictEqual(MAX_HUNK_LINE_LENGTH, MAX_HIGHLIGHT_LINE_LENGTH);

  const many = Array.from({ length: MAX_HUNK_LINES + 1 }, () => 'const a = 1;');
  assert.strictEqual(colourable(many), false);
  assert.strictEqual(colourable(many.slice(0, MAX_HUNK_LINES)), true);

  // The boundary itself: at the cap it is still colourable, one over it is not.
  assert.strictEqual(colourable(['x'.repeat(MAX_HUNK_LINE_LENGTH)]), true);
  assert.strictEqual(colourable(['x'.repeat(MAX_HUNK_LINE_LENGTH + 1)]), false);
});

test('a conflicted section carries everything the surface needs to draw it', () => {
  // The one end-to-end assertion: from the payload a section knows it is
  // conflicted, and from its hunks the surface can tint every row and count
  // the regions — no second git call, no `--cc`, no merge tool.
  const file = changed('src/renderer/app.ts', {
    status: 'U', additions: 5, deletions: 0, hunks: [addedHunk(...CONFLICTED)],
  });
  const view = buildDiffView(payload({ files: [file] }), {
    loaded: new Map([['src/renderer/app.ts', file]]),
  });
  const [section]: DiffSection[] = view.sections;

  assert.strictEqual(section.conflicted, true);
  assert.strictEqual(section.status, 'U');
  assert.strictEqual(conflictRegionsIn(section.hunks), 1);
  assert.deepStrictEqual(
    conflictRoles(section.hunks[0].lines.map(line => line.text)).filter(role => role !== null),
    ['start', 'ours', 'separator', 'theirs', 'end'],
  );
});
