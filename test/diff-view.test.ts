import { test } from 'node:test';
import assert from 'node:assert';
import {
  DEFAULT_OVERSCAN, HEAD_HEIGHT, MAX_ESTIMATED_ROWS, ROW_HEIGHT,
  bodyFor, buildDiffView, estimatedHeight, isPureRename, primaryClaim, sortSections,
  totalsOf, visibleSections,
} from '../src/renderer/features/code/diff-view-model';
import type { DiffSection } from '../src/renderer/features/code/diff-view-model';
import type { ChangesPayload } from '../src/domain/changes/types';
import type { DiffBase, FileDiff, FileStatus, Hunk } from '../src/domain/git/types';
import type { SessionClaim } from '../src/domain/attribution/types';

/**
 * The whole-worktree diff's rules, exercised without a DOM.
 *
 * `diff-view-model.ts` is deliberately the only part of the surface with
 * decisions in it — `diff-view.ts` builds elements, calls `gitDiffFile` and
 * drives an intersection observer — and it imports nothing that touches
 * `document`, which is what lets this file import it at all. The renderer has
 * no jsdom harness and does not want one.
 */

const MAIN: DiffBase = { kind: 'merge-base', ref: 'main' };
const UNCOMMITTED: DiffBase = { kind: 'uncommitted' };

/** A tracked file, as `changedFiles` reports one: classified, and with no hunks. */
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

function untracked(path: string): FileStatus {
  return { path, status: '?' };
}

function claim(sessionId: string, lastAtIso = '2026-09-09T10:00:00Z', edits = 1): SessionClaim {
  return { sessionId, lastAtIso, edits };
}

function payload(over: Partial<ChangesPayload> = {}): ChangesPayload {
  return { base: MAIN, requestedBase: MAIN, files: [], untracked: [], claims: {}, ...over };
}

/** Every section as `path:body`, in the order the scroll draws them. */
function shape(sections: readonly DiffSection[]): string[] {
  return sections.map(section => `${section.path}:${section.body}`);
}

function hunk(lines: number): Hunk {
  return {
    header: '@@ -1,1 +1,1 @@',
    oldStart: 1,
    newStart: 1,
    lines: Array.from({ length: lines }, () => ({ kind: 'ctx' as const, text: 'x' })),
  };
}

// ── order ─────────────────────────────────────────────────────────────────────

test('sections follow git, and the reformats go to the bottom', () => {
  const view = buildDiffView(payload({
    files: [
      changed('src/a.ts'),
      changed('src/reformatted.ts', { whitespaceOnly: true }),
      changed('src/b.ts'),
      changed('src/also-reformatted.ts', { whitespaceOnly: true }),
      changed('src/c.ts'),
    ],
  }));

  // git's own order within each half, and the two whitespace-only files last
  // however far apart git reported them — a reformat must never bury the one
  // real change in a 212-file migration.
  assert.deepStrictEqual(view.sections.map(section => section.path), [
    'src/a.ts', 'src/b.ts', 'src/c.ts',
    'src/reformatted.ts', 'src/also-reformatted.ts',
  ]);
  assert.strictEqual(view.whitespaceOnly, 2);
});

test('turning Ignore whitespace off puts the reformats back where git had them', () => {
  const files = [
    changed('src/a.ts'),
    changed('src/reformatted.ts', { whitespaceOnly: true }),
    changed('src/b.ts'),
  ];
  const view = buildDiffView(payload({ files }), { ignoreWhitespace: false });

  assert.deepStrictEqual(view.sections.map(section => section.path), [
    'src/a.ts', 'src/reformatted.ts', 'src/b.ts',
  ]);
  // And the body opens rather than staying folded — that is the other half of
  // what the toggle means.
  assert.strictEqual(view.sections[1].body, 'hunks');
});

test('sortSections is stable on both sides of the partition', () => {
  const section = (path: string, whitespaceOnly: boolean): DiffSection => ({
    path, status: 'M', additions: 1, deletions: 1, binary: false, generated: false,
    submodule: false, whitespaceOnly, untracked: false, body: 'hunks', hunks: [],
    loaded: false, claims: [],
  });
  const sorted = sortSections([
    section('a', false), section('w1', true), section('b', false), section('w2', true),
  ]);
  assert.deepStrictEqual(sorted.map(s => s.path), ['a', 'b', 'w1', 'w2']);
});

// ── the generated partition ───────────────────────────────────────────────────

test('generated files are hidden and counted, not dropped', () => {
  const files = [
    changed('src/app.ts'),
    changed('package-lock.json', { generated: true, truncated: 'generated', additions: 12481 }),
    changed('dist/bundle.js', { generated: true, truncated: 'generated' }),
  ];

  const hidden = buildDiffView(payload({ files }));
  assert.deepStrictEqual(hidden.sections.map(section => section.path), ['src/app.ts']);
  assert.strictEqual(hidden.generatedHidden, 2);
  // The header still speaks for the whole change set: what the banner took away
  // the banner says itself, in its own words.
  assert.strictEqual(hidden.totals.files, 3);
  assert.strictEqual(hidden.totals.additions, 3 + 12481 + 3);

  const shown = buildDiffView(payload({ files }), { hideGenerated: false });
  assert.strictEqual(shown.sections.length, 3);
  assert.strictEqual(shown.generatedHidden, 0);
  // Shown, but still not rendered: `Show them` is not `render 12,481 lines`.
  assert.strictEqual(shown.sections[1].body, 'generated');
});

// ── which files are collapsed ─────────────────────────────────────────────────

test('a file past the oversize threshold is folded, and Expand undoes it', () => {
  const files = [changed('src/style.scss', {
    truncated: 'size', additions: 1204, deletions: 1198,
  })];

  const folded = buildDiffView(payload({ files }));
  assert.strictEqual(folded.sections[0].body, 'oversize');

  const opened = buildDiffView(payload({ files }), { expanded: new Set(['src/style.scss']) });
  assert.strictEqual(opened.sections[0].body, 'hunks');
});

test('every collapse is reversible, and nothing but a collapse answers to Expand', () => {
  const cases: [Partial<FileDiff>, string, string][] = [
    [{ truncated: 'size' }, 'oversize', 'hunks'],
    [{ generated: true, truncated: 'generated' }, 'generated', 'hunks'],
    [{ whitespaceOnly: true }, 'whitespace', 'hunks'],
    // These are not collapses — they are all there is to show — so expanding
    // one has nothing to open.
    [{ binary: true, additions: 0, deletions: 0 }, 'binary', 'binary'],
    [{ submodule: true }, 'submodule', 'submodule'],
    [{ status: 'R', oldPath: 'old.ts', additions: 0, deletions: 0 }, 'rename', 'rename'],
  ];

  for (const [over, folded, open] of cases) {
    const files = [changed('f', over)];
    const shut = buildDiffView(payload({ files }), { hideGenerated: false });
    const wide = buildDiffView(payload({ files }), {
      hideGenerated: false, expanded: new Set(['f']),
    });
    assert.strictEqual(shut.sections[0].body, folded, JSON.stringify(over));
    assert.strictEqual(wide.sections[0].body, open, JSON.stringify(over));
  }
});

test('what phase two learns changes how a file draws', () => {
  const files = [changed('src/db.ts')];
  const plain = buildDiffView(payload({ files }));
  assert.strictEqual(plain.sections[0].body, 'hunks');
  assert.strictEqual(plain.sections[0].loaded, false);

  // `whitespaceOnly` costs a second diff, so `getChanges` never sets it and
  // `gitDiffFile` does. The later answer wins.
  const loaded = new Map([['src/db.ts', changed('src/db.ts', {
    whitespaceOnly: true, hunks: [hunk(4)],
  })]]);
  const after = buildDiffView(payload({ files }), { loaded });
  assert.strictEqual(after.sections[0].body, 'whitespace');
  assert.strictEqual(after.sections[0].loaded, true);
  assert.strictEqual(after.sections[0].hunks.length, 1);
});

// ── a rename is one line ──────────────────────────────────────────────────────

test('a rename with no content change is one line, never a delete plus an add', () => {
  const view = buildDiffView(payload({
    files: [changed('src/renderer/sidebar.ts', {
      status: 'R', oldPath: 'public/sidebar.js', similarity: 98,
      additions: 0, deletions: 0,
    })],
  }));

  assert.strictEqual(view.sections.length, 1);
  const [section] = view.sections;
  assert.strictEqual(section.body, 'rename');
  assert.strictEqual(section.oldPath, 'public/sidebar.js');
  assert.strictEqual(section.similarity, 98);
  // One line and nothing under it: the header *is* the row.
  assert.strictEqual(estimatedHeight(section), HEAD_HEIGHT + ROW_HEIGHT);
});

test('a rename that also changed lines is a rename with hunks', () => {
  const view = buildDiffView(payload({
    files: [changed('new.ts', { status: 'R', oldPath: 'old.ts', similarity: 74 })],
  }));
  assert.strictEqual(view.sections[0].body, 'hunks');
  assert.strictEqual(isPureRename(view.sections[0]), false);
  assert.strictEqual(isPureRename({ status: 'R', additions: 0, deletions: 0 }), true);
  assert.strictEqual(isPureRename({ status: 'C', additions: 0, deletions: 0 }), true);
  assert.strictEqual(isPureRename({ status: 'M', additions: 0, deletions: 0 }), false);
});

// ── the diffstat ──────────────────────────────────────────────────────────────

test('the header adds up every changed file, including the ones it is hiding', () => {
  const view = buildDiffView(payload({
    files: [
      changed('a.ts', { additions: 38, deletions: 11 }),
      changed('b.ts', { additions: 12, deletions: 4 }),
      changed('package-lock.json', {
        generated: true, truncated: 'generated', additions: 12481, deletions: 417,
      }),
      changed('icon.png', { binary: true, additions: 0, deletions: 0, status: 'A' }),
    ],
  }));

  assert.deepStrictEqual(view.totals, { files: 4, additions: 12531, deletions: 432 });
  assert.deepStrictEqual(totalsOf(view.sections), { files: 3, additions: 50, deletions: 15 });
});

test('an untracked file counts only when a session claims it', () => {
  const view = buildDiffView(payload({
    files: [changed('a.ts')],
    untracked: [untracked('src/new.ts'), untracked('node_modules/x/index.js')],
    claims: { 'src/new.ts': [claim('s-1')] },
  }));

  // The same rule the Changes list keeps, so the two surfaces cannot disagree
  // about how many files changed.
  assert.deepStrictEqual(shape(view.sections), ['a.ts:hunks', 'src/new.ts:untracked']);
  assert.strictEqual(view.totals.files, 2);
});

// ── the base ──────────────────────────────────────────────────────────────────

test('a base git could not use is reported as a mismatch', () => {
  assert.strictEqual(buildDiffView(payload()).baseMismatch, false);

  // Invariant 7: the ref was gone or HEAD is detached, so git fell back to
  // uncommitted-only. The surface shows the base that was used and says so.
  const fell = buildDiffView(payload({ base: UNCOMMITTED, requestedBase: MAIN }));
  assert.strictEqual(fell.baseMismatch, true);
  assert.strictEqual(fell.base.kind, 'uncommitted');
  assert.strictEqual(fell.requestedBase.kind, 'merge-base');
});

// ── who wrote it ──────────────────────────────────────────────────────────────

test('a section carries its claims, most recent first, and none is not an error', () => {
  const view = buildDiffView(payload({
    files: [changed('a.ts'), changed('b.ts')],
    claims: { 'a.ts': [claim('s-1', '2026-09-09T12:00:00Z'), claim('s-2', '2026-09-09T09:00:00Z')] },
  }));

  assert.strictEqual(view.sections[0].claims.length, 2);
  assert.strictEqual(primaryClaim(view.sections[0])?.sessionId, 's-1');
  assert.strictEqual(primaryClaim(view.sections[1]), null);
});

// ── what a body decision does not depend on ───────────────────────────────────

test('a submodule and a binary outrank every other reading of a file', () => {
  const base: DiffSection = {
    path: 'vendor/sdk', status: 'M', additions: 0, deletions: 0, binary: false,
    generated: true, submodule: true, whitespaceOnly: true, untracked: false,
    truncated: 'generated', body: 'none', hunks: [], loaded: false, claims: [],
  };
  assert.strictEqual(bodyFor(base, false), 'submodule');
  assert.strictEqual(bodyFor({ ...base, submodule: false, binary: true }, false), 'binary');
});

// ── lazy rendering ────────────────────────────────────────────────────────────

test('a section is guessed from its diffstat, and the guess is capped', () => {
  const of = (over: Partial<DiffSection>): DiffSection => ({
    path: 'f', status: 'M', additions: 0, deletions: 0, binary: false, generated: false,
    submodule: false, whitespaceOnly: false, untracked: false, body: 'hunks', hunks: [],
    loaded: false, claims: [], ...over,
  });

  // Three rows of context either side of a small change.
  assert.strictEqual(estimatedHeight(of({ additions: 4, deletions: 2 })),
    HEAD_HEIGHT + 12 * ROW_HEIGHT);

  // A regenerated lockfile must not reserve a quarter of a million pixels for a
  // section that is going to draw one collapsed line.
  assert.strictEqual(estimatedHeight(of({ additions: 12481, deletions: 417 })),
    HEAD_HEIGHT + MAX_ESTIMATED_ROWS * ROW_HEIGHT);

  // Once the lines exist, the guess is replaced by the count.
  assert.strictEqual(
    estimatedHeight(of({ loaded: true, hunks: [hunk(5), hunk(3)], additions: 900 })),
    HEAD_HEIGHT + 10 * ROW_HEIGHT,
  );
});

test('only the sections near the viewport are worth building', () => {
  // Twelve sections of 100px in a 300px window. Overscan is one screen, so the
  // build reaches from 300px above the top of the viewport to 300px below its
  // bottom: scrolled to 500 that is (200, 1100), which is sections 2 to 10.
  const heights = Array.from({ length: 12 }, () => 100);

  assert.deepStrictEqual(
    visibleSections(heights, { scrollTop: 500, height: 300, overscan: DEFAULT_OVERSCAN }),
    [2, 3, 4, 5, 6, 7, 8, 9, 10],
  );

  // At the top there is nothing above to overscan into, so the window is
  // (−300, 600) and the build stops at the section starting exactly at 600.
  assert.deepStrictEqual(
    visibleSections(heights, { scrollTop: 0, height: 300 }),
    [0, 1, 2, 3, 4, 5],
  );

  // No overscan is the viewport itself, and only the sections that actually
  // show a pixel in it: [100,200) and [500,600) both touch and neither counts.
  assert.deepStrictEqual(
    visibleSections(heights, { scrollTop: 200, height: 300, overscan: 0 }),
    [2, 3, 4],
  );
});

test('the visible set copes with a scroll that has outlived its content', () => {
  assert.deepStrictEqual(visibleSections([], { scrollTop: 0, height: 800 }), []);

  // A list that has shrunk under a scroll position past its end still renders
  // something rather than going blank.
  assert.deepStrictEqual(
    visibleSections([100, 100], { scrollTop: 9000, height: 300 }),
    [1],
  );

  // A height of zero — the half is folded, so the box cannot be measured. One
  // section is built, and `refreshDiffView` does the rest once it can be.
  assert.deepStrictEqual(visibleSections([100, 100, 100], { scrollTop: 0, height: 0 }), [0]);
});

test('uneven sections are measured cumulatively, not by index', () => {
  // A 2,000px lockfile followed by three small files: the window at the top
  // must not reach past it just because it is only the first of four.
  const heights = [2000, 40, 40, 40];
  assert.deepStrictEqual(
    visibleSections(heights, { scrollTop: 0, height: 400, overscan: 0 }),
    [0],
  );
  assert.deepStrictEqual(
    visibleSections(heights, { scrollTop: 1900, height: 400, overscan: 0 }),
    [0, 1, 2, 3],
  );
});
