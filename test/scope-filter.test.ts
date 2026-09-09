import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert';
import { narrowToScope } from '../src/domain/git/scope';
import type { Scope } from '../src/domain/git/types';
import type { SessionRow } from '../src/domain/session/session';

const PROJECT = '/Users/j/dev/proj';
const CLAUDE_WT = PROJECT + '/.claude/worktrees/feat-x';
const PLAIN_WT = '/Users/j/dev/proj-feature';
const OTHER = '/Users/j/dev/other';

// The parent's `git worktree list`: the primary first, then both flavours.
const KNOWN = [PROJECT, CLAUDE_WT, PLAIN_WT];

interface Row { sessionId: string; projectPath: string; cwd?: string | null }
interface Proj { projectPath: string; folder: string; sessions: Row[] }

/** `cwd` left out entirely when not given — the shape of a row that never touched disk. */
function row(sessionId: string, projectPath: string, cwd?: string | null): Row {
  return cwd === undefined ? { sessionId, projectPath } : { sessionId, projectPath, cwd };
}

function fixture(): Proj[] {
  return [
    { projectPath: PROJECT, folder: 'proj', sessions: [
      row('p1', PROJECT, PROJECT),
      // Claude CLI's --worktree: folded into the parent, cwd says where.
      row('wt1', PROJECT, CLAUDE_WT),
      // Indexed before cwd was recorded.
      row('legacy', PROJECT, null),
      // Never touched disk: pending, terminal, remote.
      row('nocwd', PROJECT),
    ] },
    // `git worktree add ../proj-feature`: its own project today.
    { projectPath: PLAIN_WT, folder: 'proj-feature', sessions: [row('plain1', PLAIN_WT, PLAIN_WT)] },
    { projectPath: OTHER, folder: 'other', sessions: [row('o1', OTHER, OTHER), row('o-pending', OTHER)] },
  ];
}

const never = () => false;
const ids = (projects: readonly Proj[]) =>
  projects.map(p => [p.projectPath, p.sessions.map(s => s.sessionId)] as const);

test('a null scope hands back the very same array', () => {
  const projects = fixture();
  assert.strictEqual(narrowToScope(projects, null, KNOWN, never), projects);
});

test('a project scope keeps the project, its folded worktree rows and a listed plain worktree, and drops the rest', () => {
  const scope: Scope = { projectPath: PROJECT, worktreePath: null };
  assert.deepStrictEqual(ids(narrowToScope(fixture(), scope, KNOWN, never)), [
    [PROJECT, ['p1', 'wt1', 'legacy', 'nocwd']],
    [PLAIN_WT, ['plain1']],
  ]);
  // Without the worktree list, nothing ties the plain checkout to the parent.
  assert.deepStrictEqual(ids(narrowToScope(fixture(), scope, [], never)), [
    [PROJECT, ['p1', 'wt1', 'legacy', 'nocwd']],
  ]);
});

test('a worktree scope keeps only the rows that ran in that checkout', () => {
  const claude: Scope = { projectPath: PROJECT, worktreePath: CLAUDE_WT };
  assert.deepStrictEqual(ids(narrowToScope(fixture(), claude, KNOWN, never)), [
    [PROJECT, ['wt1']],
  ]);

  // The plain worktree's rows live under their own project; the scoped project
  // has none left but stays, because it is the one the user is looking at.
  const plain: Scope = { projectPath: PROJECT, worktreePath: PLAIN_WT };
  assert.deepStrictEqual(ids(narrowToScope(fixture(), plain, KNOWN, never)), [
    [PROJECT, []],
    [PLAIN_WT, ['plain1']],
  ]);
});

test('rows with no cwd fall back to their projectPath, which is the primary checkout', () => {
  const primary: Scope = { projectPath: PROJECT, worktreePath: PROJECT };
  assert.deepStrictEqual(ids(narrowToScope(fixture(), primary, KNOWN, never)), [
    [PROJECT, ['p1', 'legacy', 'nocwd']],
  ]);
});

test('pending rows are always kept, whichever project they are in', () => {
  const scope: Scope = { projectPath: PROJECT, worktreePath: CLAUDE_WT };
  const pending = (id: string) => id === 'o-pending';
  assert.deepStrictEqual(ids(narrowToScope(fixture(), scope, KNOWN, pending)), [
    [PROJECT, ['wt1']],
    [OTHER, ['o-pending']],
  ]);
});

test('the scoped project stays, empty, when nothing in it matches', () => {
  const projects: Proj[] = [
    { projectPath: PROJECT, folder: 'proj', sessions: [row('wt1', PROJECT, CLAUDE_WT)] },
    { projectPath: OTHER, folder: 'other', sessions: [row('o1', OTHER, OTHER)] },
  ];
  const primary: Scope = { projectPath: PROJECT, worktreePath: PROJECT };
  assert.deepStrictEqual(ids(narrowToScope(projects, primary, KNOWN, never)), [[PROJECT, []]]);
  // However the scope spells the path.
  const slashed: Scope = { projectPath: PROJECT + '/', worktreePath: PROJECT };
  assert.deepStrictEqual(ids(narrowToScope(projects, slashed, KNOWN, never)), [[PROJECT, []]]);
});

test('narrowing rebuilds the projects it keeps and leaves the input alone', () => {
  const projects = fixture();
  const before = ids(projects);
  const narrowed = narrowToScope(projects, { projectPath: PROJECT, worktreePath: null }, KNOWN, never);
  assert.notStrictEqual(narrowed[0], projects[0]);
  assert.strictEqual(narrowed[0].folder, 'proj', 'the other fields come along');
  assert.deepStrictEqual(ids(projects), before);
});

// ── scope-store ──
//
// The store reads Web Storage at module load, so a fake `localStorage` has to
// be in place before the import — which is why the module is imported in a
// hook rather than at the top of the file. Node has no localStorage of its own.

type ScopeStore = typeof import('../src/renderer/state/scope-store');
type SessionStore = typeof import('../src/renderer/state/session-store');

const stored = new Map<string, string>();
let store: ScopeStore;
let sessions: SessionStore;

before(async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, String(value)); },
      removeItem: (key: string) => { stored.delete(key); },
    },
  });
  // What an older build, or a hand edit, might have left behind.
  stored.set('scope', '{"projectPath":');
  store = await import('../src/renderer/state/scope-store');
  sessions = await import('../src/renderer/state/session-store');
});

/** Run `fn` with console.error captured, so a deliberate failure stays quiet. */
function capturingErrors(fn: () => void): unknown[][] {
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    fn();
  } finally {
    console.error = original;
  }
  return logged;
}

test('a malformed stored scope reads as All', () => {
  assert.strictEqual(store.getScope(), null);
  assert.strictEqual(sessions.STORAGE_KEYS.scope, 'scope', 'the key the fake was seeded under');
});

beforeEach(() => {
  store.setScope(null);
  store.setKnownWorktrees(PROJECT, []);
});

test('setting the scope persists it as JSON, notifies, and clears on null', () => {
  const heard: (Scope | null)[] = [];
  const off = store.onScopeChange(scope => heard.push(scope));
  try {
    const scope: Scope = { projectPath: PROJECT, worktreePath: CLAUDE_WT };
    store.setScope(scope);
    assert.deepStrictEqual(store.getScope(), scope);
    assert.deepStrictEqual(JSON.parse(stored.get('scope')!), scope);

    store.setScope(null);
    assert.strictEqual(store.getScope(), null);
    assert.strictEqual(stored.has('scope'), false, 'All is the absence of a stored scope');
    assert.deepStrictEqual(heard, [scope, null]);
  } finally {
    off();
  }
});

test('choosing the current scope again is silent, and an unsubscribed listener hears nothing', () => {
  const heard: (Scope | null)[] = [];
  const off = store.onScopeChange(scope => heard.push(scope));
  const scope: Scope = { projectPath: PROJECT, worktreePath: null };
  store.setScope(scope);
  store.setScope({ ...scope });
  assert.strictEqual(heard.length, 1);

  off();
  store.setScope(null);
  assert.strictEqual(heard.length, 1);
});

test('a throwing listener is logged and the listeners after it still run', () => {
  const heard: (Scope | null)[] = [];
  const offBad = store.onScopeChange(() => { throw new Error('rail failed to highlight'); });
  const offGood = store.onScopeChange(scope => heard.push(scope));
  try {
    const logged = capturingErrors(() => store.setScope({ projectPath: PROJECT, worktreePath: null }));
    assert.strictEqual(store.getScope()?.projectPath, PROJECT, 'the change landed');
    assert.strictEqual(heard.length, 1);
    assert.strictEqual(logged.length, 1);
  } finally {
    offBad();
    offGood();
  }
});

test('known worktrees are empty until reported, and a report for the scoped project re-notifies', () => {
  assert.deepStrictEqual([...store.knownWorktreesFor(PROJECT)], []);
  store.setScope({ projectPath: PROJECT, worktreePath: null });

  const heard: (Scope | null)[] = [];
  const off = store.onScopeChange(scope => heard.push(scope));
  try {
    store.setKnownWorktrees(PROJECT, KNOWN);
    assert.deepStrictEqual([...store.knownWorktreesFor(PROJECT)], KNOWN);
    assert.deepStrictEqual(heard, [{ projectPath: PROJECT, worktreePath: null }],
      'what the scope admits changed, so the listeners are told');

    // The same list again, or a list for a project not in scope: nothing changed.
    store.setKnownWorktrees(PROJECT, [...KNOWN]);
    store.setKnownWorktrees(OTHER, [OTHER, '/Users/j/dev/other-wt']);
    assert.strictEqual(heard.length, 1);
  } finally {
    off();
  }
});

test('reconciling drops a scope whose project has left the list and keeps one still there', () => {
  const heard: (Scope | null)[] = [];
  const off = store.onScopeChange(scope => heard.push(scope));
  try {
    store.setScope({ projectPath: PROJECT, worktreePath: PLAIN_WT });
    store.reconcileScopeWithProjects([{ projectPath: OTHER }, { projectPath: PROJECT }]);
    assert.strictEqual(store.getScope()?.projectPath, PROJECT);

    store.reconcileScopeWithProjects([{ projectPath: OTHER }]);
    assert.strictEqual(store.getScope(), null);
    assert.strictEqual(stored.has('scope'), false, 'the drop is persisted too');
    assert.deepStrictEqual(heard.map(s => s?.projectPath ?? null), [PROJECT, null]);

    // Nothing to do with no scope — and silent about it.
    store.reconcileScopeWithProjects([]);
    assert.strictEqual(heard.length, 2);
  } finally {
    off();
  }
});

test('scopedProjects applies the store and always admits a pending row', () => {
  const pendingRow: SessionRow = {
    sessionId: 'o-pending', summary: '', firstPrompt: '', projectPath: OTHER,
    created: '', modified: '', messageCount: 0, name: null, starred: 0, archived: 0,
  };
  sessions.pendingSessions.set('o-pending', { session: pendingRow, projectPath: OTHER, folder: 'other' });
  try {
    const projects = fixture();
    assert.strictEqual(store.scopedProjects(projects), projects, 'no scope: the same array');

    store.setScope({ projectPath: PROJECT, worktreePath: null });
    assert.deepStrictEqual(ids(store.scopedProjects(projects)), [
      [PROJECT, ['p1', 'wt1', 'legacy', 'nocwd']],
      [OTHER, ['o-pending']],
    ], 'no worktree list yet, so the plain checkout is not tied to the parent');

    store.setKnownWorktrees(PROJECT, KNOWN);
    assert.deepStrictEqual(ids(store.scopedProjects(projects)), [
      [PROJECT, ['p1', 'wt1', 'legacy', 'nocwd']],
      [PLAIN_WT, ['plain1']],
      [OTHER, ['o-pending']],
    ]);
  } finally {
    sessions.pendingSessions.delete('o-pending');
  }
});
