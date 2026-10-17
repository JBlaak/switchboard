import { test } from 'node:test';
import assert from 'node:assert';
import { initialRendererState, rekeyState, rootReducer } from '../src/renderer/state/root';
import { selectedItem, steppedItemId, workSections } from '../src/renderer/state/session-work-slice';
import {
  closedIssues, footprintLine, githubBanner, itemBranchLine, itemKind, itemPills, itemRef, itemTitle,
  updatedAgo,
} from '../src/renderer/ui/session-work/describe';
import type { RendererEvent } from '../src/renderer/state/events';
import type { RendererState } from '../src/renderer/state/root';
import type { SessionWorkItem, SessionWorkSnapshot } from '../src/domain/session-work/model';

function run(state: RendererState, ...events: RendererEvent[]): RendererState {
  return events.reduce((s, e) => rootReducer(Object.freeze(s), e), state);
}

const AT = Date.parse('2026-06-10T14:00:00.000Z');

const openPr: SessionWorkItem = {
  id: 'pr:https://github.com/acme/api/pull/52',
  kind: 'pr',
  pr: {
    number: 52, url: 'https://github.com/acme/api/pull/52', repository: 'acme/api',
    title: 'Fix the login redirect', state: 'open', behindBy: 3, baseRef: 'main', headRef: 'fix/login',
    checks: [{ name: 'test', state: 'passing' }, { name: 'lint', state: 'pending' }],
    closes: [{ repository: '', number: 48 }],
  },
  location: { worktree: '/w/api', branch: 'fix/login', fromSubagent: false },
  diff: { kind: 'local', worktree: '/w/api', base: 'origin/main', head: 'fix/login' },
  activity: null,
};
const branch: SessionWorkItem = {
  id: 'branch:/w/api-2\0spike',
  kind: 'branch',
  location: { worktree: '/w/api-2', branch: 'spike', fromSubagent: true },
  ahead: 2,
  diff: { kind: 'local', worktree: '/w/api-2', base: 'origin/main', head: 'spike' },
  activity: null,
};
const dirty: SessionWorkItem = {
  id: 'dirty:/w/api\0fix/login',
  kind: 'dirty',
  location: { worktree: '/w/api', branch: 'fix/login', fromSubagent: false },
  files: [{ path: 'a.ts', status: 'modified' }, { path: 'b.ts', status: 'untracked' }],
};
const issue: SessionWorkItem = {
  id: 'issue:acme/api#49',
  kind: 'issue',
  issue: { repository: 'acme/api', number: 49, title: 'Stale row', state: 'open', url: 'https://github.com/acme/api/issues/49' },
};
const merged: SessionWorkItem = {
  id: 'pr:https://github.com/acme/api/pull/50',
  kind: 'pr',
  pr: { number: 50, url: 'https://github.com/acme/api/pull/50', repository: 'acme/api', title: 'Old', state: 'merged', closes: [] },
  location: null,
  diff: { kind: 'pull-request', repository: 'acme/api', number: 50 },
  activity: null,
};

function snapshot(items: SessionWorkItem[], sessionId = 's1'): SessionWorkSnapshot {
  return { sessionId, repository: 'acme/api', items, gh: 'ok', updatedAt: new Date(AT).toISOString() };
}

const opened = (sessionId = 's1'): RendererEvent => ({ type: 'sessionWorkOpened', sessionId, name: 'Fix login', at: AT });

// ── Opening and closing ──

test('session work: opening shows a skeleton for that session; the first snapshot fills it', () => {
  const open = run(initialRendererState('s1'), opened());
  assert.deepStrictEqual(open.sessionWork.page, {
    sessionId: 's1', name: 'Fix login', snapshot: null, selectedItemId: null, doneExpanded: false,
  });
  assert.strictEqual(open.sessionWork.now, AT);

  const filled = run(open, { type: 'sessionWorkSnapshot', snapshot: snapshot([openPr, branch]) });
  assert.strictEqual(filled.sessionWork.page?.snapshot?.items.length, 2);
  assert.strictEqual(filled.sessionWork.page?.selectedItemId, openPr.id, 'the first item is selected');
});

test('session work: opening the open page again changes nothing', () => {
  const open = run(initialRendererState('s1'), opened());
  assert.strictEqual(run(open, opened()), open);
});

test('session work: a snapshot for another session, or with no page open, is dropped', () => {
  const closed = initialRendererState('s1');
  assert.strictEqual(run(closed, { type: 'sessionWorkSnapshot', snapshot: snapshot([openPr]) }), closed);
  const open = run(closed, opened());
  assert.strictEqual(run(open, { type: 'sessionWorkSnapshot', snapshot: snapshot([openPr], 's2') }), open);
});

test('session work: closing only closes the page of that session', () => {
  const open = run(initialRendererState('s1'), opened());
  assert.strictEqual(run(open, { type: 'sessionWorkClosed', sessionId: 's2' }), open);
  assert.strictEqual(run(open, { type: 'sessionWorkClosed', sessionId: 's1' }).sessionWork.page, null);
});

test('session work: another session on screen, a cleared screen, or the settings panel close it', () => {
  const open = run(initialRendererState('s1'), opened());
  assert.strictEqual(run(open, { type: 'activeSessionChanged', sessionId: 's2' }).sessionWork.page, null);
  assert.strictEqual(run(open, { type: 'activeSessionChanged', sessionId: null }).sessionWork.page, null);
  assert.ok(run(open, { type: 'activeSessionChanged', sessionId: 's1' }).sessionWork.page, 'its own session stays');
  assert.strictEqual(run(open, { type: 'sessionShown', sessionId: 's1', name: 'x' }).sessionWork.page, null,
    'clicking its own row shows the terminal again');
  const settings = run(open, {
    type: 'settingsOpened', scope: 'global', projectPath: null, current: {}, globalSettings: {},
    shellProfiles: [], appVersion: null,
  });
  assert.strictEqual(settings.sessionWork.page, null);
});

test('session work: nothing is remembered once closed', () => {
  const used = run(initialRendererState('s1'), opened(),
    { type: 'sessionWorkSnapshot', snapshot: snapshot([openPr, branch, merged]) },
    { type: 'sessionWorkItemSelected', itemId: branch.id },
    { type: 'sessionWorkDoneToggled' },
    { type: 'sessionWorkClosed', sessionId: 's1' },
    opened());
  assert.deepStrictEqual(used.sessionWork.page, {
    sessionId: 's1', name: 'Fix login', snapshot: null, selectedItemId: null, doneExpanded: false,
  });
});

test('session work: the page follows a re-key, and so does what is known about the session', () => {
  const open = run(initialRendererState('s1'), opened(),
    { type: 'sessionWorkEligibility', sessionId: 's1', canOpen: true });
  const moved = rekeyState(open, 's1', 's9');
  assert.strictEqual(moved.sessionWork.page?.sessionId, 's9');
  assert.deepStrictEqual(moved.sessionWork.canOpen, { s9: true });
});

test('session work: a rename of its session renames the header', () => {
  const open = run(initialRendererState('s1'), opened());
  assert.strictEqual(run(open, { type: 'headerRenamed', sessionId: 's1', name: 'New' }).sessionWork.page?.name, 'New');
  assert.strictEqual(run(open, { type: 'headerRenamed', sessionId: 's2', name: 'New' }), open);
});

test('session work: the clock only ticks while the page is open', () => {
  const closed = initialRendererState('s1');
  assert.strictEqual(run(closed, { type: 'sessionWorkTicked', at: AT + 1000 }), closed);
  const open = run(closed, opened(), { type: 'sessionWorkTicked', at: AT + 4000 });
  assert.strictEqual(open.sessionWork.now, AT + 4000);
});

// ── Eligibility ──

test('session work: eligibility is cached per session, and a "no" is asked again once the session is shown', () => {
  const known = run(initialRendererState(),
    { type: 'sessionWorkEligibility', sessionId: 'yes', canOpen: true },
    { type: 'sessionWorkEligibility', sessionId: 'no', canOpen: false });
  assert.deepStrictEqual(known.sessionWork.canOpen, { yes: true, no: false });
  assert.strictEqual(run(known, { type: 'sessionWorkEligibility', sessionId: 'yes', canOpen: true }), known);

  const shown = run(known, { type: 'sessionShown', sessionId: 'no', name: '' });
  assert.deepStrictEqual(shown.sessionWork.canOpen, { yes: true });
  assert.deepStrictEqual(run(known, { type: 'sessionShown', sessionId: 'yes', name: '' }).sessionWork.canOpen,
    { yes: true, no: false }, 'a "yes" stays');
});

// ── Selection ──

test('session work: the selection survives a new snapshot while its item does', () => {
  const selected = run(initialRendererState('s1'), opened(),
    { type: 'sessionWorkSnapshot', snapshot: snapshot([openPr, branch]) },
    { type: 'sessionWorkItemSelected', itemId: branch.id });
  assert.strictEqual(selected.sessionWork.page?.selectedItemId, branch.id);

  const kept = run(selected, { type: 'sessionWorkSnapshot', snapshot: snapshot([dirty, branch]) });
  assert.strictEqual(kept.sessionWork.page?.selectedItemId, branch.id);
  const gone = run(selected, { type: 'sessionWorkSnapshot', snapshot: snapshot([dirty]) });
  assert.strictEqual(gone.sessionWork.page?.selectedItemId, dirty.id);
});

test('session work: issues are links, not selectable; nothing selectable selects nothing', () => {
  const page = run(initialRendererState('s1'), opened(),
    { type: 'sessionWorkSnapshot', snapshot: snapshot([issue]) });
  assert.strictEqual(page.sessionWork.page?.selectedItemId, null);
  assert.strictEqual(run(page, { type: 'sessionWorkItemSelected', itemId: issue.id }), page);
});

test('session work: j/k step through the visible items and stop at the ends', () => {
  const state = run(initialRendererState('s1'), opened(),
    { type: 'sessionWorkSnapshot', snapshot: snapshot([openPr, branch, issue, merged]) });
  const page = state.sessionWork.page!;
  assert.strictEqual(steppedItemId(page, 1), branch.id);
  assert.strictEqual(steppedItemId(page, -1), null);
  const atBranch = { ...page, selectedItemId: branch.id };
  assert.strictEqual(steppedItemId(atBranch, 1), null, 'Done is collapsed');
  assert.strictEqual(steppedItemId({ ...atBranch, doneExpanded: true }, 1), merged.id, 'and skips the issue');
  assert.strictEqual(selectedItem(atBranch), branch);
});

test('session work: items group as in progress, issues and done', () => {
  const sections = workSections(snapshot([openPr, issue, merged, branch, dirty]));
  assert.deepStrictEqual(sections.inProgress, [openPr, branch, dirty]);
  assert.deepStrictEqual(sections.issues, [issue]);
  assert.deepStrictEqual(sections.done, [merged]);
});

// ── What the page says ──

test('session work: each kind of item has its kind, ref and title', () => {
  assert.deepStrictEqual([openPr, branch, dirty, issue].map(itemKind), ['PR', 'Branch', 'Uncommitted', 'Issue']);
  assert.deepStrictEqual([openPr, branch, dirty, issue].map(itemRef), ['#52', 'no PR', 'fix/login', '#49']);
  assert.deepStrictEqual([openPr, branch, dirty, issue].map(itemTitle),
    ['Fix the login redirect', 'spike', 'Uncommitted changes in api', 'Stale row']);
});

test('session work: pills put CI first, then the state, then how far behind', () => {
  assert.deepStrictEqual(itemPills(openPr), [
    { label: 'CI running', tone: 'amber' },
    { label: '3 behind main', tone: 'amber' },
  ]);
  const failingDraft: SessionWorkItem = {
    ...openPr,
    pr: { ...openPr.pr, state: 'draft', behindBy: 0, checks: [{ name: 't', state: 'failing' }, { name: 'u', state: 'pending' }] },
  } as SessionWorkItem;
  assert.deepStrictEqual(itemPills(failingDraft), [{ label: 'CI failing', tone: 'red' }, { label: 'Draft', tone: 'grey' }]);
  assert.deepStrictEqual(itemPills(merged), [{ label: 'Merged', tone: 'lavender' }]);
  assert.deepStrictEqual(itemPills(dirty), [{ label: '2 files', tone: 'grey' }]);
  assert.deepStrictEqual(itemPills(issue), [{ label: 'Open', tone: 'green' }]);
  const unknown: SessionWorkItem = { ...openPr, pr: { number: 1, url: 'u', repository: '', closes: [] } } as SessionWorkItem;
  assert.deepStrictEqual(itemPills(unknown), [], 'no gh, no pills');
});

test('session work: the detail line, and the issues a PR closes', () => {
  assert.strictEqual(itemBranchLine(openPr), 'fix/login → main');
  assert.strictEqual(itemBranchLine(branch), 'spike → origin/main');
  assert.deepStrictEqual(closedIssues(openPr, 'acme/api'), [{ label: '#48', url: 'https://github.com/acme/api/issues/48' }]);
});

test('session work: the header names the repository, the footprint and how fresh it is', () => {
  const snap = snapshot([issue, openPr, branch, dirty]);
  assert.strictEqual(footprintLine(snap), '2 worktrees · 2 branches');
  assert.strictEqual(footprintLine(snapshot([dirty])), '1 worktree · 1 branch');
  assert.strictEqual(updatedAgo(snap.updatedAt, AT + 4_000), 'updated 4s ago');
  assert.strictEqual(updatedAgo(snap.updatedAt, AT - 5_000), 'updated 0s ago', 'a clock behind main is "now"');
  assert.strictEqual(updatedAgo(snap.updatedAt, AT + 125_000), 'updated 2m ago');
});

test('session work: the gh banner says what to do, and nothing when gh works', () => {
  assert.strictEqual(githubBanner('ok'), null);
  assert.match(githubBanner('missing')!, /Install and sign in to the GitHub CLI/);
  assert.match(githubBanner('unauthenticated')!, /gh auth login/);
});
