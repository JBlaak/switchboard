import { test } from 'node:test';
import assert from 'node:assert';
import { initialRendererState, rekeyState, rootReducer } from '../src/renderer/state/root';
import { selectedItem, steppedItemId, workSections } from '../src/renderer/state/session-work-slice';
import {
  closedIssues, footprintLine, githubBanner, itemBranchLine, itemKind, itemLineStats, itemPills, itemRef, itemTitle,
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
  additions: 40,
  deletions: 7,
  pushed: false,
};
const dirty: SessionWorkItem = {
  id: 'dirty:/w/api\0fix/login',
  kind: 'dirty',
  location: { worktree: '/w/api', branch: 'fix/login', fromSubagent: false },
  files: [{ path: 'a.ts', status: 'modified' }, { path: 'b.ts', status: 'untracked' }],
  activity: null,
  additions: 12,
  deletions: 3,
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
  return { sessionId, repository: 'acme/api', items, footprint: { worktrees: 2, branches: 2 }, queued: 0, gh: 'ok', updatedAt: new Date(AT).toISOString() };
}

const opened = (sessionId = 's1'): RendererEvent => ({ type: 'sessionWorkOpened', sessionId, name: 'Fix login', at: AT });

// ── Opening and closing ──

const EMPTY_PAGE = {
  sessionId: 's1', name: 'Fix login', snapshot: null, selectedItemId: null, doneExpanded: false,
  diffMode: 'unified', diffs: {}, pendingAction: null, actionError: null, composer: null, reviewPending: null, reviewError: null,
};
const openPage = () => run(initialRendererState('s1'), opened());

test('session work: opening shows a skeleton for that session', () => {
  /* Given */
  const state = initialRendererState('s1');

  /* When */
  const open = run(state, opened());

  /* Then */
  assert.deepStrictEqual(open.sessionWork.page, EMPTY_PAGE);
  assert.strictEqual(open.sessionWork.now, AT);
});

test('session work: the first snapshot fills the skeleton and selects the first item', () => {
  /* Given */
  const open = openPage();

  /* When */
  const filled = run(open, { type: 'sessionWorkSnapshot', snapshot: snapshot([openPr, branch]) });

  /* Then */
  assert.strictEqual(filled.sessionWork.page?.snapshot?.items.length, 2);
  assert.strictEqual(filled.sessionWork.page?.selectedItemId, openPr.id, 'the first item is selected');
});

test('session work: opening the open page again changes nothing', () => {
  /* Given */
  const open = openPage();

  /* When */
  const next = run(open, opened());

  /* Then */
  assert.strictEqual(next, open);
});

test('session work: a snapshot with no page open is dropped', () => {
  /* Given */
  const closed = initialRendererState('s1');

  /* When */
  const next = run(closed, { type: 'sessionWorkSnapshot', snapshot: snapshot([openPr]) });

  /* Then */
  assert.strictEqual(next, closed);
});

test('session work: a snapshot for another session is dropped', () => {
  /* Given */
  const open = openPage();

  /* When */
  const next = run(open, { type: 'sessionWorkSnapshot', snapshot: snapshot([openPr], 's2') });

  /* Then */
  assert.strictEqual(next, open);
});

test('session work: closing another session\'s page leaves this one open', () => {
  /* Given */
  const open = openPage();

  /* When */
  const next = run(open, { type: 'sessionWorkClosed', sessionId: 's2' });

  /* Then */
  assert.strictEqual(next, open);
});

test('session work: closing the page of its session closes it', () => {
  /* Given */
  const open = openPage();

  /* When */
  const next = run(open, { type: 'sessionWorkClosed', sessionId: 's1' });

  /* Then */
  assert.strictEqual(next.sessionWork.page, null);
});

test('session work: another session on screen, or a cleared screen, closes it', () => {
  /* Given */
  const open = openPage();

  for (const sessionId of ['s2', null]) {
    /* When */
    const next = run(open, { type: 'activeSessionChanged', sessionId });

    /* Then */
    assert.strictEqual(next.sessionWork.page, null, String(sessionId));
  }
});

test('session work: its own session becoming active keeps it open', () => {
  /* Given */
  const open = openPage();

  /* When */
  const next = run(open, { type: 'activeSessionChanged', sessionId: 's1' });

  /* Then */
  assert.ok(next.sessionWork.page, 'its own session stays');
});

test('session work: clicking its own row shows the terminal again', () => {
  /* Given */
  const open = openPage();

  /* When */
  const next = run(open, { type: 'sessionShown', sessionId: 's1', name: 'x' });

  /* Then */
  assert.strictEqual(next.sessionWork.page, null, 'clicking its own row shows the terminal again');
});

test('session work: the settings panel closes it', () => {
  /* Given */
  const open = openPage();

  /* When */
  const settings = run(open, {
    type: 'settingsOpened', scope: 'global', projectPath: null, current: {}, globalSettings: {},
    shellProfiles: [], appVersion: null,
  });

  /* Then */
  assert.strictEqual(settings.sessionWork.page, null);
});

test('session work: nothing is remembered once closed', () => {
  /* Given */
  const used = run(initialRendererState('s1'), opened(),
    { type: 'sessionWorkSnapshot', snapshot: snapshot([openPr, branch, merged]) },
    { type: 'sessionWorkItemSelected', itemId: branch.id },
    { type: 'sessionWorkDoneToggled' },
    { type: 'sessionWorkDiffModeSet', mode: 'split' },
    { type: 'sessionWorkDiffRequested', sessionId: 's1', itemId: branch.id, key: 'k' },
    { type: 'sessionWorkClosed', sessionId: 's1' });

  /* When */
  const reopened = run(used, opened());

  /* Then */
  assert.deepStrictEqual(reopened.sessionWork.page, EMPTY_PAGE);
});

test('session work: the page follows a re-key, and so does what is known about the session', () => {
  /* Given */
  const open = run(initialRendererState('s1'), opened(),
    { type: 'sessionWorkEligibility', sessionId: 's1', canOpen: true });

  /* When */
  const moved = rekeyState(open, 's1', 's9');

  /* Then */
  assert.strictEqual(moved.sessionWork.page?.sessionId, 's9');
  assert.deepStrictEqual(moved.sessionWork.canOpen, { s9: true });
});

test('session work: a rename of its session renames the header', () => {
  /* Given */
  const open = openPage();

  /* When */
  const next = run(open, { type: 'headerRenamed', sessionId: 's1', name: 'New' });

  /* Then */
  assert.strictEqual(next.sessionWork.page?.name, 'New');
});

test('session work: a rename of another session changes nothing', () => {
  /* Given */
  const open = openPage();

  /* When */
  const next = run(open, { type: 'headerRenamed', sessionId: 's2', name: 'New' });

  /* Then */
  assert.strictEqual(next, open);
});

test('session work: the clock does not tick while the page is closed', () => {
  /* Given */
  const closed = initialRendererState('s1');

  /* When */
  const next = run(closed, { type: 'sessionWorkTicked', at: AT + 1000 });

  /* Then */
  assert.strictEqual(next, closed);
});

test('session work: the clock ticks while the page is open', () => {
  /* Given */
  const open = openPage();

  /* When */
  const next = run(open, { type: 'sessionWorkTicked', at: AT + 4000 });

  /* Then */
  assert.strictEqual(next.sessionWork.now, AT + 4000);
});

// ── Eligibility ──

const eligibilityKnown = () => run(initialRendererState(),
  { type: 'sessionWorkEligibility', sessionId: 'yes', canOpen: true },
  { type: 'sessionWorkEligibility', sessionId: 'no', canOpen: false });

test('session work: eligibility is cached per session', () => {
  /* When */
  const known = eligibilityKnown();

  /* Then */
  assert.deepStrictEqual(known.sessionWork.canOpen, { yes: true, no: false });
});

test('session work: the same eligibility again changes nothing', () => {
  /* Given */
  const known = eligibilityKnown();

  /* When */
  const next = run(known, { type: 'sessionWorkEligibility', sessionId: 'yes', canOpen: true });

  /* Then */
  assert.strictEqual(next, known);
});

test('session work: a "no" is asked again once the session is shown', () => {
  /* Given */
  const known = eligibilityKnown();

  /* When */
  const shown = run(known, { type: 'sessionShown', sessionId: 'no', name: '' });

  /* Then */
  assert.deepStrictEqual(shown.sessionWork.canOpen, { yes: true });
});

test('session work: a "yes" stays once the session is shown', () => {
  /* Given */
  const known = eligibilityKnown();

  /* When */
  const shown = run(known, { type: 'sessionShown', sessionId: 'yes', name: '' });

  /* Then */
  assert.deepStrictEqual(shown.sessionWork.canOpen, { yes: true, no: false }, 'a "yes" stays');
});

// ── Selection ──

const branchSelected = () => run(initialRendererState('s1'), opened(),
  { type: 'sessionWorkSnapshot', snapshot: snapshot([openPr, branch]) },
  { type: 'sessionWorkItemSelected', itemId: branch.id });

test('session work: selecting an item selects it', () => {
  /* Given */
  const filled = run(initialRendererState('s1'), opened(),
    { type: 'sessionWorkSnapshot', snapshot: snapshot([openPr, branch]) });

  /* When */
  const selected = run(filled, { type: 'sessionWorkItemSelected', itemId: branch.id });

  /* Then */
  assert.strictEqual(selected.sessionWork.page?.selectedItemId, branch.id);
});

test('session work: the selection survives a new snapshot while its item does', () => {
  /* Given */
  const selected = branchSelected();

  /* When */
  const kept = run(selected, { type: 'sessionWorkSnapshot', snapshot: snapshot([dirty, branch]) });

  /* Then */
  assert.strictEqual(kept.sessionWork.page?.selectedItemId, branch.id);
});

test('session work: the selection moves to the first item once its item is gone', () => {
  /* Given */
  const selected = branchSelected();

  /* When */
  const gone = run(selected, { type: 'sessionWorkSnapshot', snapshot: snapshot([dirty]) });

  /* Then */
  assert.strictEqual(gone.sessionWork.page?.selectedItemId, dirty.id);
});

test('session work: nothing selectable selects nothing', () => {
  /* Given */
  const open = openPage();

  /* When */
  const page = run(open, { type: 'sessionWorkSnapshot', snapshot: snapshot([issue]) });

  /* Then */
  assert.strictEqual(page.sessionWork.page?.selectedItemId, null);
});

test('session work: issues are links, not selectable', () => {
  /* Given */
  const page = run(initialRendererState('s1'), opened(),
    { type: 'sessionWorkSnapshot', snapshot: snapshot([issue]) });

  /* When */
  const next = run(page, { type: 'sessionWorkItemSelected', itemId: issue.id });

  /* Then */
  assert.strictEqual(next, page);
});

const steppingPage = () => run(initialRendererState('s1'), opened(),
  { type: 'sessionWorkSnapshot', snapshot: snapshot([openPr, branch, issue, merged]) }).sessionWork.page!;

test('session work: j steps to the next visible item', () => {
  /* Given */
  const page = steppingPage();

  /* When */
  const next = steppedItemId(page, 1);

  /* Then */
  assert.strictEqual(next, branch.id);
});

test('session work: k stops at the first item', () => {
  /* Given */
  const page = steppingPage();

  /* When */
  const previous = steppedItemId(page, -1);

  /* Then */
  assert.strictEqual(previous, null);
});

test('session work: j stops at the last visible item while Done is collapsed', () => {
  /* Given */
  const atBranch = { ...steppingPage(), selectedItemId: branch.id };

  /* When */
  const next = steppedItemId(atBranch, 1);

  /* Then */
  assert.strictEqual(next, null, 'Done is collapsed');
});

test('session work: j steps into an expanded Done and skips the issue', () => {
  /* Given */
  const expanded = { ...steppingPage(), selectedItemId: branch.id, doneExpanded: true };

  /* When */
  const next = steppedItemId(expanded, 1);

  /* Then */
  assert.strictEqual(next, merged.id, 'and skips the issue');
});

test('session work: the selected item is looked up by its id', () => {
  /* Given */
  const atBranch = { ...steppingPage(), selectedItemId: branch.id };

  /* When */
  const item = selectedItem(atBranch);

  /* Then */
  assert.strictEqual(item, branch);
});

test('session work: items group as in progress, issues and done', () => {
  /* Given */
  const snap = snapshot([openPr, issue, merged, branch, dirty]);

  /* When */
  const sections = workSections(snap);

  /* Then */
  assert.deepStrictEqual(sections.inProgress, [openPr, branch, dirty]);
  assert.deepStrictEqual(sections.issues, [issue]);
  assert.deepStrictEqual(sections.done, [merged]);
});

const closedIssue: SessionWorkItem = {
  id: 'issue:acme/api#40', kind: 'issue',
  issue: { repository: 'acme/api', number: 40, title: 'Fixed elsewhere', state: 'closed', url: 'https://github.com/acme/api/issues/40' },
};
const bareIssue: SessionWorkItem = { id: 'issue:#41', kind: 'issue', issue: { repository: '', number: 41 } };
const withClosedIssue = () => snapshot([openPr, closedIssue, issue, bareIssue, merged]);

test('session work: a closed issue goes under Done, after the PRs', () => {
  /* Given */
  const snap = withClosedIssue();

  /* When */
  const sections = workSections(snap);

  /* Then */
  assert.deepStrictEqual(sections.issues, [issue, bareIssue], 'open, or unknown without gh');
  assert.deepStrictEqual(sections.done, [merged, closedIssue]);
});

test('session work: a closed issue under Done is a link, not a stop', () => {
  /* Given */
  const page = run(initialRendererState('s1'), opened(), { type: 'sessionWorkSnapshot', snapshot: withClosedIssue() },
    { type: 'sessionWorkDoneToggled' }).sessionWork.page!;

  /* When */
  const next = steppedItemId({ ...page, selectedItemId: merged.id }, 1);

  /* Then */
  assert.strictEqual(next, null, 'the closed issue is a link, not a stop');
});

test('session work: a closed issue is never selected', () => {
  /* Given */
  const filled = run(initialRendererState('s1'), opened(), { type: 'sessionWorkSnapshot', snapshot: withClosedIssue() });

  /* When */
  const selected = run(filled, { type: 'sessionWorkItemSelected', itemId: closedIssue.id });

  /* Then */
  assert.strictEqual(selected.sessionWork.page!.selectedItemId, openPr.id);
});

// ── What the page says ──

test('session work: each kind of item has its kind', () => {
  /* When */
  const kinds = [openPr, branch, dirty, issue].map(itemKind);

  /* Then */
  assert.deepStrictEqual(kinds, ['PR', 'Branch', 'Uncommitted', 'Issue']);
});

test('session work: each kind of item has its ref', () => {
  /* When */
  const refs = [openPr, branch, dirty, issue].map(itemRef);

  /* Then */
  assert.deepStrictEqual(refs, ['#52', 'no PR', 'fix/login', '#49']);
});

test('session work: each kind of item has its title', () => {
  /* When */
  const titles = [openPr, branch, dirty, issue].map(itemTitle);

  /* Then */
  assert.deepStrictEqual(titles, ['Fix the login redirect', 'spike', 'Uncommitted changes in api', 'Stale row']);
});

test('session work: pills put CI first, then the state, then how far behind', () => {
  /* Given */
  const failingDraft: SessionWorkItem = {
    ...openPr,
    pr: { ...openPr.pr, state: 'draft', behindBy: 0, checks: [{ name: 't', state: 'failing' }, { name: 'u', state: 'pending' }] },
  } as SessionWorkItem;
  const cases: [string, SessionWorkItem, ReturnType<typeof itemPills>][] = [
    ['open PR', openPr, [{ label: 'CI running', tone: 'amber' }, { label: '3 behind main', tone: 'amber' }]],
    ['failing draft', failingDraft, [{ label: 'CI failing', tone: 'red' }, { label: 'Draft', tone: 'grey' }]],
    ['merged PR', merged, [{ label: 'Merged', tone: 'lavender' }]],
    ['dirty', dirty, [{ label: '2 files', tone: 'grey' }]],
    ['unpushed branch', branch, [{ label: 'Not pushed', tone: 'amber' }, { label: '2 commits ahead', tone: 'grey' }]],
    ['pushed branch', { ...branch, pushed: true } as SessionWorkItem, [{ label: '2 commits ahead', tone: 'grey' }]],
    ['issue', issue, [{ label: 'Open', tone: 'green' }]],
  ];

  for (const [name, item, expected] of cases) {
    /* When */
    const pills = itemPills(item);

    /* Then */
    assert.deepStrictEqual(pills, expected, name);
  }
});

test('session work: no gh, no pills', () => {
  /* Given */
  const unknown: SessionWorkItem = { ...openPr, pr: { number: 1, url: 'u', repository: '', closes: [] } } as SessionWorkItem;

  /* When */
  const pills = itemPills(unknown);

  /* Then */
  assert.deepStrictEqual(pills, [], 'no gh, no pills');
});

test('session work: each item\'s +a −d, unknown for a PR gh has not counted', () => {
  /* Given */
  const counted = { ...openPr, pr: { ...openPr.pr, additions: 42, deletions: 9 } } as SessionWorkItem;
  const cases: [string, SessionWorkItem, ReturnType<typeof itemLineStats>][] = [
    ['uncounted PR', openPr, null],
    ['counted PR', counted, { additions: 42, deletions: 9 }],
    ['branch', branch, { additions: 40, deletions: 7 }],
    ['dirty', dirty, { additions: 12, deletions: 3 }],
    ['issue', issue, null],
  ];

  for (const [name, item, expected] of cases) {
    /* When */
    const stats = itemLineStats(item);

    /* Then */
    assert.deepStrictEqual(stats, expected, name);
  }
});

test('session work: a PR\'s detail line runs from its head to its base', () => {
  /* When */
  const line = itemBranchLine(openPr);

  /* Then */
  assert.strictEqual(line, 'fix/login → main');
});

test('session work: a branch\'s detail line runs from the branch to what it diffs against', () => {
  /* When */
  const line = itemBranchLine(branch);

  /* Then */
  assert.strictEqual(line, 'spike → origin/main');
});

test('session work: the issues a PR closes', () => {
  /* When */
  const issues = closedIssues(openPr, 'acme/api');

  /* Then */
  assert.deepStrictEqual(issues, [{ label: '#48', url: 'https://github.com/acme/api/issues/48' }]);
});

test('session work: the header names the footprint', () => {
  /* Given */
  const snap = snapshot([issue, openPr, branch, dirty]);

  /* When */
  const line = footprintLine(snap);

  /* Then */
  assert.strictEqual(line, '2 worktrees · 2 branches');
});

test('session work: the footprint is counted from where the session worked, not from the items', () => {
  // Counted from where the session worked, not from the items: nothing left
  // to show still worked somewhere.
  /* Given */
  const snap = { ...snapshot([]), footprint: { worktrees: 1, branches: 1 } };

  /* When */
  const line = footprintLine(snap);

  /* Then */
  assert.strictEqual(line, '1 worktree · 1 branch');
});

test('session work: the header says how fresh it is', () => {
  /* Given */
  const { updatedAt } = snapshot([issue, openPr, branch, dirty]);
  const cases: [number, string, string?][] = [
    [AT + 4_000, 'updated 4s ago'],
    [AT - 5_000, 'updated 0s ago', 'a clock behind main is "now"'],
    [AT + 125_000, 'updated 2m ago'],
  ];

  for (const [now, expected, message] of cases) {
    /* When */
    const ago = updatedAgo(updatedAt, now);

    /* Then */
    assert.strictEqual(ago, expected, message ?? expected);
  }
});

test('session work: the gh banner says nothing when gh works', () => {
  /* When */
  const banner = githubBanner('ok');

  /* Then */
  assert.strictEqual(banner, null);
});

test('session work: the gh banner says to install gh when it is missing', () => {
  /* When */
  const banner = githubBanner('missing');

  /* Then */
  assert.match(banner!, /Install and sign in to the GitHub CLI/);
});

test('session work: the gh banner says to log in when gh is not signed in', () => {
  /* When */
  const banner = githubBanner('unauthenticated');

  /* Then */
  assert.match(banner!, /gh auth login/);
});
