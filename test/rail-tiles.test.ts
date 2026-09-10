import { test } from 'node:test';
import assert from 'node:assert';
import {
  RAIL_GAP_PX, RAIL_TILE_PX,
  badgeFor, lastActivityAt, monogramFor, orderRailProjects, railBadge, splitForRail,
  worktreeLabel, worktreeMonograms, worktreeStackCap,
} from '../src/renderer/features/rail/rail-model';
import type { RailRow } from '../src/renderer/features/rail/rail-model';
import type { Scope, Worktree } from '../src/domain/git/types';
import type { SessionSignals } from '../src/domain/session/tiers';

/**
 * The rail's rules, exercised without a DOM.
 *
 * `rail-model.ts` is deliberately the only part of the rail with decisions in
 * it — the other two modules build elements — and it imports nothing that
 * touches `document`, which is what lets this file import it at all.
 */

const QUIET: SessionSignals = {
  needsAttention: false, responseReady: false, busy: false, pending: false, hasLivePty: false,
};
const signals = (over: Partial<SessionSignals>): SessionSignals => ({ ...QUIET, ...over });

// ── badge precedence ──────────────────────────────────────────────────────────

test('nothing to say is no badge', () => {
  assert.strictEqual(badgeFor([]), null);
  assert.strictEqual(badgeFor([QUIET, QUIET]), null);
  // Busy without a live PTY is a stale flag from a session that has since gone;
  // the rail reports the PTY, which is what the poll actually observed.
  assert.strictEqual(badgeFor([signals({ busy: true })]), null);
  assert.strictEqual(badgeFor([signals({ pending: true })]), null);
});

test('one signal each', () => {
  assert.strictEqual(badgeFor([signals({ hasLivePty: true })]), 'running');
  assert.strictEqual(badgeFor([signals({ responseReady: true })]), 'unread');
  assert.strictEqual(badgeFor([signals({ needsAttention: true })]), 'waiting');
});

test('waiting outranks unread outranks running, whatever order they arrive in', () => {
  const running = signals({ hasLivePty: true });
  const unread = signals({ responseReady: true });
  const waiting = signals({ needsAttention: true });

  assert.strictEqual(badgeFor([running, unread]), 'unread');
  assert.strictEqual(badgeFor([unread, running]), 'unread');
  assert.strictEqual(badgeFor([running, unread, waiting]), 'waiting');
  assert.strictEqual(badgeFor([waiting, running, unread]), 'waiting');
  assert.strictEqual(badgeFor([running, waiting]), 'waiting');
});

// ── which sessions a tile speaks for (invariant 4) ────────────────────────────

const PROJECT = '/Users/j/dev/proj';
const CLAUDE_WT = PROJECT + '/.claude/worktrees/feat-x';
const OTHER = '/Users/j/dev/other';

const ROWS: RailRow[] = [
  { sessionId: 'primary', projectPath: PROJECT, cwd: PROJECT },
  { sessionId: 'inWorktree', projectPath: PROJECT, cwd: CLAUDE_WT },
  { sessionId: 'elsewhere', projectPath: OTHER, cwd: OTHER },
];
const KNOWN = new Map<string, readonly string[]>([[PROJECT, [PROJECT, CLAUDE_WT]]]);
const worktreesFor = (projectPath: string): readonly string[] => KNOWN.get(projectPath) ?? [];

const signalsOf = (attention: readonly string[], live: readonly string[] = []) =>
  (sessionId: string): SessionSignals => signals({
    needsAttention: attention.includes(sessionId),
    hasLivePty: live.includes(sessionId),
  });

const projectTile = (projectPath: string): Scope => ({ projectPath, worktreePath: null });

test('a worktree that needs input badges its parent tile', () => {
  const badge = railBadge(
    ROWS, signalsOf(['inWorktree']), projectTile(PROJECT), null, worktreesFor);
  assert.strictEqual(badge, 'waiting');
});

test('another project stays another project', () => {
  assert.strictEqual(
    railBadge(ROWS, signalsOf(['elsewhere']), projectTile(PROJECT), null, worktreesFor), null);
  assert.strictEqual(
    railBadge(ROWS, signalsOf(['elsewhere']), projectTile(OTHER), null, worktreesFor), 'waiting');
});

test('the tile you are scoped to says nothing about itself', () => {
  const scope = projectTile(PROJECT);
  assert.strictEqual(
    railBadge(ROWS, signalsOf(['primary', 'inWorktree']), scope, scope, worktreesFor), null);
  // …and the projects you are not looking at keep reporting.
  assert.strictEqual(
    railBadge(ROWS, signalsOf(['elsewhere']), projectTile(OTHER), scope, worktreesFor), 'waiting');
});

test('scoped to one worktree, the parent tile still reports the others', () => {
  const scope: Scope = { projectPath: PROJECT, worktreePath: CLAUDE_WT };
  // The row inside the scoped checkout is on screen; the primary's is not.
  assert.strictEqual(
    railBadge(ROWS, signalsOf(['inWorktree']), projectTile(PROJECT), scope, worktreesFor), null);
  assert.strictEqual(
    railBadge(ROWS, signalsOf(['primary']), projectTile(PROJECT), scope, worktreesFor), 'waiting');
  // The sub-tile of the scoped checkout says nothing about itself either.
  assert.strictEqual(railBadge(
    ROWS, signalsOf(['inWorktree']),
    { projectPath: PROJECT, worktreePath: CLAUDE_WT }, scope, worktreesFor), null);
});

test('the All tile reports exactly what the scope is hiding', () => {
  const everything = signalsOf([], ['primary', 'elsewhere']);
  // No scope: nothing is hidden, so it has nothing to report.
  assert.strictEqual(railBadge(ROWS, everything, null, null, worktreesFor), null);
  assert.strictEqual(
    railBadge(ROWS, everything, null, projectTile(PROJECT), worktreesFor), 'running');
  assert.strictEqual(
    railBadge(ROWS, signalsOf([], ['primary']), null, projectTile(PROJECT), worktreesFor), null);
});

// ── monograms ────────────────────────────────────────────────────────────────

test('a one-word project gives its first two letters, only the first capitalised', () => {
  assert.strictEqual(monogramFor('/Users/j/dev/switchboard'), 'Sw');
  assert.strictEqual(monogramFor('/Users/j/dev/switchboard/'), 'Sw');
  assert.strictEqual(monogramFor('C:\\code\\Switchboard'), 'Sw');
});

test('a multi-word project gives initials', () => {
  assert.strictEqual(monogramFor('/Users/j/dev/my-app'), 'MA');
  assert.strictEqual(monogramFor('/Users/j/dev/switchboard.old'), 'SO');
  assert.strictEqual(monogramFor('/Users/j/dev/deep_work_2'), 'DW');
});

test('a remote project is known by its directory, or by its host when it has none', () => {
  assert.strictEqual(monogramFor('ssh://j@box/dev/payments'), 'Pa');
  assert.strictEqual(monogramFor('ssh://j@box/~/side-project'), 'SP');
  assert.strictEqual(monogramFor('ssh://j@buildbox'), 'Bu');
  assert.strictEqual(monogramFor('ssh://j@buildbox:2222'), 'Bu');
});

test('nothing to monogram still renders', () => {
  assert.strictEqual(monogramFor('/'), '?');
  assert.strictEqual(monogramFor(''), '?');
  assert.strictEqual(monogramFor('/Users/j/dev/x'), 'X');
  assert.strictEqual(monogramFor('/Users/j/dev/---'), '?');
});

// ── ordering ─────────────────────────────────────────────────────────────────

interface TestProject { projectPath: string; remote?: boolean; sessions: { modified: string }[] }

const at = (...times: string[]) => times.map(modified => ({ modified }));

const PROJECTS: TestProject[] = [
  { projectPath: '/dev/stale', sessions: at('2026-01-01T00:00:00Z') },
  { projectPath: '/dev/hot', sessions: at('2026-01-01T00:00:00Z', '2026-03-01T00:00:00Z') },
  { projectPath: '/dev/remote-old', remote: true, sessions: at('2026-01-05T00:00:00Z') },
  { projectPath: '/dev/hot/.claude/worktrees/feat', sessions: at('2026-04-01T00:00:00Z') },
  { projectPath: '/dev/remote-new', remote: true, sessions: at('2026-02-05T00:00:00Z') },
  { projectPath: '/dev/empty', sessions: [] },
];

const paths = (projects: readonly TestProject[]) => projects.map(project => project.projectPath);

test('local projects most-recently-active first, remote ones after them', () => {
  assert.deepStrictEqual(paths(orderRailProjects(PROJECTS, new Set())), [
    // The worktree is the most recent thing on the machine but is still local.
    '/dev/hot/.claude/worktrees/feat',
    '/dev/hot',
    '/dev/stale',
    '/dev/empty',
    '/dev/remote-new',
    '/dev/remote-old',
  ]);
});

test('a project that is another one’s worktree gets no tile of its own', () => {
  const absorbed = new Set(['/dev/hot/.claude/worktrees/feat']);
  assert.deepStrictEqual(paths(orderRailProjects(PROJECTS, absorbed)), [
    '/dev/hot', '/dev/stale', '/dev/empty', '/dev/remote-new', '/dev/remote-old',
  ]);
});

test('projects with nothing to sort on keep a stable order between reloads', () => {
  const quiet: TestProject[] = [
    { projectPath: '/dev/c', sessions: [] },
    { projectPath: '/dev/a', sessions: [] },
    { projectPath: '/dev/b', sessions: [] },
  ];
  assert.deepStrictEqual(paths(orderRailProjects(quiet, new Set())), ['/dev/a', '/dev/b', '/dev/c']);
  assert.deepStrictEqual(
    paths(orderRailProjects([...quiet].reverse(), new Set())), ['/dev/a', '/dev/b', '/dev/c']);
});

test('a project’s activity is its newest session, and 0 when it has none', () => {
  assert.strictEqual(lastActivityAt({ projectPath: '/x', sessions: [] }), 0);
  assert.strictEqual(
    lastActivityAt({ projectPath: '/x', sessions: at('2026-03-01T00:00:00Z', '2026-01-01T00:00:00Z') }),
    new Date('2026-03-01T00:00:00Z').getTime());
});

// ── overflow ─────────────────────────────────────────────────────────────────

/** A plain tile: 32px plus the 6px gap above it. */
const TILE_COST = RAIL_TILE_PX + RAIL_GAP_PX;
const plain = (n: number) => Array.from({ length: n }, (_, i) => 'p' + i);
const cost = () => TILE_COST;

test('everything that fits is shown, and nothing is hidden', () => {
  const { shown, hidden } = splitForRail(plain(5), cost, TILE_COST * 5);
  assert.deepStrictEqual(shown, plain(5));
  assert.deepStrictEqual(hidden, []);
});

test('one tile over, and the last slot goes to the +N tile', () => {
  // Room for six tiles, seven projects: five drawn, two behind the overflow.
  const { shown, hidden } = splitForRail(plain(7), cost, TILE_COST * 6);
  assert.deepStrictEqual(shown, ['p0', 'p1', 'p2', 'p3', 'p4']);
  assert.deepStrictEqual(hidden, ['p5', 'p6']);
});

test('a rail with room for nothing hides everything rather than overflowing', () => {
  assert.deepStrictEqual(splitForRail(plain(3), cost, 0), { shown: [], hidden: plain(3) });
  assert.deepStrictEqual(splitForRail(plain(3), cost, -40), { shown: [], hidden: plain(3) });
  assert.deepStrictEqual(splitForRail([], cost, 0), { shown: [], hidden: [] });
});

test('the scoped project’s worktree stack is paid for out of the same budget', () => {
  // Three tiles' worth of room; the first tile is a project with four
  // sub-tiles under it and costs three tiles by itself.
  const costOf = (tile: string): number => (tile === 'p0' ? TILE_COST * 3 : TILE_COST);
  const { shown, hidden } = splitForRail(plain(4), costOf, TILE_COST * 4);
  assert.deepStrictEqual(shown, ['p0']);
  assert.deepStrictEqual(hidden, ['p1', 'p2', 'p3']);
});

// ── a worktree's monogram ─────────────────────────────────────────────────────

const worktree = (over: Partial<Worktree> & { path: string }): Worktree => ({
  head: '0'.repeat(40), branch: null, isPrimary: false, detached: false, ...over,
});

test('a checkout goes by its branch, not by the directory the CLI named it', () => {
  assert.strictEqual(
    worktreeLabel(worktree({ path: '/p/.claude/worktrees/agent-a20a8093', branch: 'feat/rail' })),
    'feat/rail',
  );
});

test('a detached checkout goes by its short head, and one with neither by its directory', () => {
  assert.strictEqual(
    worktreeLabel(worktree({
      path: '/p/.claude/worktrees/agent-a5f3', head: 'abcdef1234567890', detached: true,
    })),
    'abcdef1',
  );
  assert.strictEqual(
    worktreeLabel(worktree({ path: '/p/.claude/worktrees/agent-a5f3' })),
    'agent-a5f3',
  );
});

test('three agent checkouts on three branches get three distinguishable monograms', () => {
  // The bug this fixes, with the real names off this machine: every one of
  // these directories starts `agent-a`, so the directory monogram was "AG"
  // three times over. The branch is what tells them apart.
  const monograms = worktreeMonograms([
    worktree({ path: '/p/.claude/worktrees/agent-a20a8093fa79edba2', branch: 'feat/x' }),
    worktree({ path: '/p/.claude/worktrees/agent-a5f37af4224e0be29', branch: 'feat/y' }),
    worktree({ path: '/p/.claude/worktrees/m1-project-rail', branch: 'fix/z' }),
  ]);
  assert.strictEqual(new Set(monograms).size, 3, monograms.join(' '));
});

test('checkouts that share a leading word are told apart past the part they share', () => {
  // `feat/rail` and `feat/rail-badges` both start "FR"; dropping the shared
  // leading word is what leaves anything to distinguish.
  const monograms = worktreeMonograms([
    worktree({ path: '/p/a', branch: 'feat/diff' }),
    worktree({ path: '/p/b', branch: 'feat/rail' }),
    worktree({ path: '/p/c', branch: 'feat/scope' }),
  ]);
  assert.strictEqual(new Set(monograms).size, 3, monograms.join(' '));
});

test('two checkouts that really do read the same are left equal rather than invented apart', () => {
  const monograms = worktreeMonograms([
    worktree({ path: '/p/a', branch: 'main' }),
    worktree({ path: '/p/b', branch: 'main' }),
  ]);
  assert.deepStrictEqual(monograms, [monograms[0], monograms[0]]);
});

test('twelve agent checkouts get twelve distinct monograms, resolved across the set', () => {
  // The real names off this machine, in the order the rail drew them. Two
  // pairs collide at two characters — a20a/a2fad and a67a/a67e — and the pair
  // that gets split has to avoid the monograms the *rest* already wear:
  // splitting a20a/a2fad into A0 and Af once handed A0 to a checkout while
  // a041d52b already had it.
  const branches = [
    'main',
    'worktree-agent-a041d52bc97c3dc80', 'worktree-agent-a12095324dbcf4414',
    'worktree-agent-a20a8093fa79edba2', 'worktree-agent-a2fad0bf59b7bb3cd',
    'worktree-agent-a3b8708a63ed1d6a1', 'worktree-agent-a5f37af4224e0be29',
    'worktree-agent-a67a26ea637543dad', 'worktree-agent-a67e62dfbe09df8d2',
    'worktree-agent-a730b5d56a4700e8b', 'worktree-agent-a8e823526eace1212',
    'worktree-agent-a9a02fcb51edef717',
  ];
  const monograms = worktreeMonograms(
    branches.map((branch, i) => worktree({ path: `/p/w${i}`, branch })));

  assert.strictEqual(monograms.length, 12);
  assert.strictEqual(new Set(monograms).size, 12, monograms.join(' '));
});

// ── the stack must not starve the rail ────────────────────────────────────────

test('the worktree stack is capped at half the budget, and never below three', () => {
  // A 24px sub-tile plus its 6px gap is 30px, out of half the budget less one
  // gap: 900 leaves 444px for the stack, which is 14 of them.
  assert.strictEqual(worktreeStackCap(900), 14);
  assert.strictEqual(worktreeStackCap(300), 4);
  // A rail too short to hold three still offers three: below that a stack
  // stops being a stack, and the flyout answers for the rest anyway.
  assert.strictEqual(worktreeStackCap(60), 3);
  assert.strictEqual(worktreeStackCap(0), 3);
});

test('the tile the user is scoped to is kept on the rail, never folded into +N', () => {
  // The failure this prevents, measured in the running app: a repository with
  // 23 checkouts made the scoped project cost more than the whole rail, so the
  // split hid every project and the rail showed `+21` and nothing else.
  const cost = (tile: string): number => (tile === 'p2' ? 1000 : TILE_COST);
  const { shown, hidden } = splitForRail(
    plain(4), cost, TILE_COST * 3, undefined, tile => tile === 'p2');
  assert.ok(shown.includes('p2'), `scoped tile missing from ${shown.join(',')}`);
  assert.ok(!hidden.includes('p2'));
});

test('with no tile to keep, the split is exactly what it always was', () => {
  const cost = (): number => TILE_COST;
  const budget = TILE_COST * 3;
  assert.deepStrictEqual(
    splitForRail(plain(6), cost, budget, undefined, () => false),
    splitForRail(plain(6), cost, budget),
  );
});
