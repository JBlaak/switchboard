import { test } from 'node:test';
import assert from 'node:assert';
import {
  CROWDED_AT,
  baseLabel, buildChangesView, sameBase, shortSessionId, statusTone,
} from '../src/renderer/features/files/changes-list-model';
import type { ChangesPayload } from '../src/domain/changes/types';
import type { DiffBase, FileDiff, FileStatus, FileStatusCode } from '../src/domain/git/types';
import type { SessionClaim } from '../src/domain/attribution/types';

/**
 * The Changes list's rules, exercised without a DOM.
 *
 * `changes-list-model.ts` is deliberately the only part of the surface with
 * decisions in it — `changes-list.ts` builds elements and calls IPC — and it
 * imports nothing that touches `document`, which is what lets this file import
 * it at all.
 */

const MAIN: DiffBase = { kind: 'merge-base', ref: 'main' };
const UNCOMMITTED: DiffBase = { kind: 'uncommitted' };

/** A tracked file, as `changedFiles` reports one: classified, and with no hunks. */
function changed(path: string, over: Partial<FileDiff> = {}): FileDiff {
  return {
    path,
    status: 'M',
    additions: 1,
    deletions: 1,
    binary: false,
    generated: false,
    whitespaceOnly: false,
    submodule: false,
    hunks: [],
    ...over,
  };
}

/** An untracked file: git knows the path and nothing else about it. */
function untracked(path: string): FileStatus {
  return { path, status: '?' };
}

function claim(sessionId: string, lastAtIso: string, edits = 1): SessionClaim {
  return { sessionId, lastAtIso, edits };
}

function payload(over: Partial<ChangesPayload> = {}): ChangesPayload {
  return {
    base: MAIN,
    requestedBase: MAIN,
    files: [],
    untracked: [],
    claims: {},
    ...over,
  };
}

/** Every group as `heading: path,path`, in the order they are drawn. */
function shape(view: { groups: readonly { sessionId: string | null; rows: readonly { path: string }[] }[] }): string[] {
  return view.groups.map(group =>
    `${group.sessionId ?? '<unclaimed>'}: ${group.rows.map(row => row.path).join(',')}`);
}

/** Enough changed files to be over the threshold, all claimed by one session. */
function crowdedPayload(): ChangesPayload {
  const files: FileDiff[] = [];
  const claims: Record<string, SessionClaim[]> = {};
  for (let i = 0; i < CROWDED_AT + 1; i++) {
    const path = `src/file-${String(i).padStart(2, '0')}.ts`;
    files.push(changed(path));
    claims[path] = [claim('s-1', '2026-09-09T10:00:00Z')];
  }
  return payload({ files, claims });
}

// ── grouping ──────────────────────────────────────────────────────────────────

test('files are grouped by the session that claims them', () => {
  const view = buildChangesView(payload({
    files: [changed('src/a.ts'), changed('src/b.ts')],
    claims: {
      'src/a.ts': [claim('alice', '2026-09-09T10:00:00Z')],
      'src/b.ts': [claim('bob', '2026-09-09T09:00:00Z')],
    },
  }));

  assert.deepStrictEqual(shape(view), ['alice: src/a.ts', 'bob: src/b.ts']);
});

test('a file two sessions claim appears under both, marked as shared', () => {
  const view = buildChangesView(payload({
    files: [changed('src/shared.ts'), changed('src/only-bob.ts')],
    claims: {
      // Two sessions on one file is routine, and showing it twice is the point
      // of the surface rather than a bug in the grouping.
      'src/shared.ts': [claim('alice', '2026-09-09T10:00:00Z'), claim('bob', '2026-09-09T09:30:00Z')],
      'src/only-bob.ts': [claim('bob', '2026-09-09T09:00:00Z')],
    },
  }));

  assert.deepStrictEqual(shape(view), [
    'alice: src/shared.ts',
    'bob: src/only-bob.ts,src/shared.ts',
  ]);

  const rows = view.groups.flatMap(group => group.rows);
  assert.ok(rows.filter(row => row.path === 'src/shared.ts').every(row => row.shared));
  assert.ok(rows.filter(row => row.path === 'src/only-bob.ts').every(row => !row.shared));
});

test('a path nothing claims falls into one group of its own', () => {
  const view = buildChangesView(payload({
    files: [changed('package-lock.json', { generated: true, additions: 12000, deletions: 900 }),
      changed('src/a.ts')],
    claims: { 'src/a.ts': [claim('alice', '2026-09-09T10:00:00Z')] },
  }));

  assert.deepStrictEqual(shape(view), ['alice: src/a.ts', '<unclaimed>: package-lock.json']);
  const [, unclaimed] = view.groups;
  assert.strictEqual(unclaimed?.kind, 'unclaimed');
  assert.strictEqual(unclaimed?.rows[0]?.generated, true);
});

test('an untracked file is shown only when a session claims it', () => {
  // git's diff cannot see untracked files, so the list decides which belong: one
  // a session created, not the rest of the working tree.
  const view = buildChangesView(payload({
    untracked: [untracked('src/new.ts'), untracked('scratch.txt')],
    claims: { 'src/new.ts': [claim('alice', '2026-09-09T10:00:00Z')] },
  }));

  assert.deepStrictEqual(shape(view), ['alice: src/new.ts']);
  assert.strictEqual(view.groups[0]?.rows[0]?.status, '?');
  assert.strictEqual(view.groups[0]?.rows[0]?.untracked, true);
  assert.strictEqual(view.totals.files, 1);
});

// ── order ─────────────────────────────────────────────────────────────────────

test('sessions come in order of their most recent claim, and the unclaimed group is last', () => {
  const view = buildChangesView(payload({
    files: [changed('src/old.ts'), changed('src/new.ts'), changed('src/mid.ts'), changed('dist/out.js')],
    claims: {
      'src/old.ts': [claim('stale', '2026-09-01T08:00:00Z')],
      // A group is as recent as its most recent claim, whichever file carried it.
      'src/new.ts': [claim('busy', '2026-09-09T18:00:00Z')],
      'src/mid.ts': [claim('busy', '2026-09-02T08:00:00Z'), claim('middling', '2026-09-05T08:00:00Z')],
    },
  }));

  assert.deepStrictEqual(shape(view), [
    'busy: src/mid.ts,src/new.ts',
    'middling: src/mid.ts',
    'stale: src/old.ts',
    '<unclaimed>: dist/out.js',
  ]);
});

test('two sessions with the same last claim still have one order', () => {
  const tie = '2026-09-09T10:00:00Z';
  const view = buildChangesView(payload({
    files: [changed('src/a.ts'), changed('src/b.ts')],
    claims: { 'src/a.ts': [claim('zoe', tie)], 'src/b.ts': [claim('adam', tie)] },
  }));

  assert.deepStrictEqual(shape(view), ['adam: src/b.ts', 'zoe: src/a.ts']);
});

// ── the diffstat ──────────────────────────────────────────────────────────────

test('the header diffstat totals every changed file, claimed or not', () => {
  const view = buildChangesView(payload({
    files: [
      changed('src/a.ts', { additions: 10, deletions: 2 }),
      changed('package-lock.json', { additions: 12000, deletions: 900, generated: true }),
      changed('logo.png', { status: 'A', additions: 0, deletions: 0, binary: true }),
    ],
    untracked: [untracked('src/new.ts'), untracked('scratch.txt')],
    claims: {
      'src/a.ts': [claim('alice', '2026-09-09T10:00:00Z')],
      'src/new.ts': [claim('alice', '2026-09-09T10:01:00Z')],
    },
  }));

  // Four rows: three tracked plus the one untracked file a session claims. An
  // untracked file has no line counts, so it adds nothing to the stat.
  assert.deepStrictEqual(view.totals, { files: 4, additions: 12010, deletions: 902 });
});

test('the diffstat describes the whole change set, not what the filter left', () => {
  const view = buildChangesView(payload({
    files: [
      changed('src/a.ts', { additions: 10, deletions: 2 }),
      changed('docs/b.md', { additions: 5, deletions: 1 }),
    ],
    claims: { 'src/a.ts': [claim('alice', '2026-09-09T10:00:00Z')] },
  }), { query: 'docs' });

  assert.deepStrictEqual(view.totals, { files: 2, additions: 15, deletions: 3 });
  assert.deepStrictEqual(shape(view), ['<unclaimed>: docs/b.md']);
  assert.strictEqual(view.hidden, 1);
});

// ── the filter ────────────────────────────────────────────────────────────────

test('the filter matches anywhere in the path, ignoring case', () => {
  const files = [changed('src/renderer/App.ts'), changed('src/main/index.ts'), changed('README.md')];
  const claims = { 'src/renderer/App.ts': [claim('alice', '2026-09-09T10:00:00Z')] };

  const byName = buildChangesView(payload({ files, claims }), { query: 'app' });
  assert.deepStrictEqual(shape(byName), ['alice: src/renderer/App.ts']);

  const byFolder = buildChangesView(payload({ files, claims }), { query: 'src/' });
  assert.deepStrictEqual(shape(byFolder), ['alice: src/renderer/App.ts', '<unclaimed>: src/main/index.ts']);

  // An empty query is not a filter, and neither is one that is all whitespace.
  const everything = buildChangesView(payload({ files, claims }), { query: '   ' });
  assert.strictEqual(everything.hidden, 0);
  assert.strictEqual(everything.totals.files, 3);
});

test('a session whose every file is filtered out loses its group', () => {
  const view = buildChangesView(payload({
    files: [changed('src/a.ts'), changed('docs/b.md')],
    claims: {
      'src/a.ts': [claim('alice', '2026-09-09T10:00:00Z')],
      'docs/b.md': [claim('bob', '2026-09-09T09:00:00Z')],
    },
  }), { query: 'docs' });

  assert.deepStrictEqual(shape(view), ['bob: docs/b.md']);
});

test('the Generated toggle drops generated files and nothing else', () => {
  const base = payload({
    files: [changed('src/a.ts'), changed('package-lock.json', { generated: true })],
    claims: {
      'src/a.ts': [claim('alice', '2026-09-09T10:00:00Z')],
      'package-lock.json': [claim('alice', '2026-09-09T10:02:00Z')],
    },
  });

  assert.deepStrictEqual(shape(buildChangesView(base)), ['alice: package-lock.json,src/a.ts']);
  assert.deepStrictEqual(shape(buildChangesView(base, { showGenerated: false })), ['alice: src/a.ts']);
  assert.strictEqual(buildChangesView(base, { showGenerated: false }).hidden, 1);
});

test('the filter field is earned, not always there', () => {
  assert.strictEqual(buildChangesView(payload({ files: [changed('src/a.ts')] })).crowded, false);
  assert.strictEqual(buildChangesView(crowdedPayload()).crowded, true);

  // Crowded is a property of the change set, so narrowing the list does not
  // take away the field that narrowed it.
  assert.strictEqual(buildChangesView(crowdedPayload(), { query: 'file-01' }).crowded, true);
});

// ── the base ──────────────────────────────────────────────────────────────────

test('a base git could not use is reported as a mismatch', () => {
  const honoured = buildChangesView(payload({ base: MAIN, requestedBase: MAIN }));
  assert.strictEqual(honoured.baseMismatch, false);

  // Invariant 7: the ref was gone or HEAD is detached, so git fell back to
  // uncommitted-only. The surface shows the base that was used and says so.
  const fell = buildChangesView(payload({ base: UNCOMMITTED, requestedBase: MAIN }));
  assert.strictEqual(fell.baseMismatch, true);
  assert.strictEqual(fell.base.kind, 'uncommitted');
  assert.strictEqual(baseLabel(fell.base), 'uncommitted');
  assert.strictEqual(baseLabel(fell.requestedBase), 'main (merge base)');
});

test('two bases are the same only when kind and ref both agree', () => {
  assert.strictEqual(sameBase(UNCOMMITTED, UNCOMMITTED), true);
  assert.strictEqual(sameBase(MAIN, MAIN), true);
  assert.strictEqual(sameBase(MAIN, { kind: 'merge-base', ref: 'master' }), false);
  // "vs main" and "vs where this branch left main" are different diffs.
  assert.strictEqual(sameBase(MAIN, { kind: 'branch', ref: 'main' }), false);
  assert.strictEqual(sameBase(MAIN, UNCOMMITTED), false);
  assert.strictEqual(baseLabel({ kind: 'branch', ref: 'main' }), 'main');
});

// ── the small rules the rows are drawn from ───────────────────────────────────

test('a status letter has a tone, and a conflict is not a shade of modified', () => {
  const tones: Record<FileStatusCode, string> = {
    M: 'mod', A: 'add', '?': 'add', D: 'del', U: 'conflict', R: 'plain', C: 'plain',
  };
  for (const [status, tone] of Object.entries(tones)) {
    assert.strictEqual(statusTone(status as FileStatusCode), tone, status);
  }
});

test('a session nobody can name is still identifiable', () => {
  assert.strictEqual(shortSessionId('9f8e7d6c-1234-5678-9abc-def012345678'), '9f8e7d6c');
  assert.strictEqual(shortSessionId('short'), 'short');
});
