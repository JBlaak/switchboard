import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GhCli, type GhResult, type GhRunner } from '../src/infrastructure/github/gh-cli';
import james22 from './fixtures/gh-plan-james-22.json';
import switchboardPlans from './fixtures/gh-plans-switchboard.json';

/** A runner that answers from a script and records what it was asked. */
function scripted(answer: (args: readonly string[]) => Partial<GhResult>): GhRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = (async (args: readonly string[]) => {
    calls.push([...args]);
    return { missing: false, code: 0, stdout: '', stderr: '', ...answer(args) };
  }) as GhRunner & { calls: string[][] };
  run.calls = calls;
  return run;
}

const answering = (body: unknown) => scripted(() => ({ stdout: JSON.stringify(body) }));
const missing = (): Partial<GhResult> => ({ missing: true, code: null });
const signedOut = (): Partial<GhResult> => ({
  code: 4,
  stderr: 'To get started with GitHub CLI, please run:  gh auth login\n',
});

/** The recorded James #22, with `edit` applied to a copy of sub-issue `number`. */
function james22With(number: number, edit: (node: any) => void): unknown {
  const copy = structuredClone(james22) as any;
  edit(copy.data.repository.issue.subIssues.nodes.find((node: any) => node.number === number));
  return copy;
}

/** The GraphQL query text of a recorded `gh api graphql` call. */
const queryOf = (args: readonly string[]) => args[args.indexOf('-f') + 1].replace(/^query=/, '');

test('a plan is one GraphQL request for the issue, its parent and its sub-issues', async () => {
  /* Given */
  const run = answering(james22);

  /* When */
  await new GhCli({ run }).plan('JBlaak/James', 22);

  /* Then */
  assert.equal(run.calls.length, 1);
  const query = queryOf(run.calls[0]);
  assert.match(query, /issue\(number: 22\)/);
  assert.match(query, /parent \{/);
  assert.match(query, /subIssues\(first: 100\)/);
  assert.match(query, /blockedBy\(/);
  assert.match(query, /closedByPullRequestsReferences\(first: 20, includeClosedPrs: true\)/);
  assert.deepEqual(run.calls[0].slice(-4), ['-f', 'owner=JBlaak', '-f', 'name=James']);
});

test('the recorded James #22 maps to a plan with 25 issues, their blockedBy links and each PR', async () => {
  /* Given */
  const gh = new GhCli({ run: answering(james22) });

  /* When */
  const plan = await gh.plan('JBlaak/James', 22);

  /* Then */
  assert.ok(plan);
  assert.deepEqual([plan.repository, plan.number, plan.title, plan.parent], ['JBlaak/James', 22, 'Spec: James v1', null]);
  assert.equal(plan.issues.length, 25);
  assert.deepEqual(plan.outside, []);

  const issue = (n: number) => plan.issues.find((candidate) => candidate.number === n)!;
  assert.deepEqual(issue(24).blockedBy, []);
  assert.deepEqual(issue(34).blockedBy, [{ repository: 'JBlaak/James', number: 33 }, { repository: 'JBlaak/James', number: 28 }]);
  assert.deepEqual(issue(40).blockedBy.map((blocker) => blocker.number), [30, 29, 27, 37]);

  assert.deepEqual(issue(24).pullRequests, [
    { number: 49, state: 'merged', draft: false, additions: 4856, deletions: 1, headRef: 'issue-24-server-walking-skeleton', baseRef: 'main' },
  ]);
  assert.deepEqual(issue(25).pullRequests, []);
  const withPr = plan.issues.filter((candidate) => candidate.pullRequests.length === 1);
  assert.equal(withPr.length, 24, 'every closed issue has its merged PR');
});

test('each issue maps its state, update time and the summary of its body', async () => {
  /* Given */
  const gh = new GhCli({ run: answering(james22) });

  /* When */
  const plan = await gh.plan('JBlaak/James', 22);

  /* Then */
  const [first, second] = plan!.issues;
  assert.deepEqual([first.number, first.state, first.closedAs], [24, 'closed', 'completed']);
  assert.deepEqual([second.number, second.state, second.closedAs], [25, 'open', null]);
  assert.match(first.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(first.summary, /^Stand up the James server/);
  assert.equal(first.acceptance.length, 5);
  assert.deepEqual(first.acceptance[1], { text: '`GET /health` returns OK without auth', done: false });
});

test('a blocker in another repository lands in plan.outside, with its state', async () => {
  /* Given */
  const response = james22With(25, (node) => {
    node.blockedBy.nodes.push({
      number: 121, title: 'Epic: Plan tab', state: 'OPEN', stateReason: null,
      updatedAt: '2026-10-17T19:24:09Z', repository: { nameWithOwner: 'JBlaak/switchboard' },
    });
  });

  /* When */
  const plan = await new GhCli({ run: answering(response) }).plan('JBlaak/James', 22);

  /* Then */
  assert.ok(plan);
  assert.deepEqual(plan.outside, [{
    repository: 'JBlaak/switchboard', number: 121, title: 'Epic: Plan tab', state: 'open', closedAs: null,
    updatedAt: '2026-10-17T19:24:09Z', blockedBy: [], pullRequests: [], summary: '', acceptance: [],
  }]);
  const blocked = plan.issues.find((issue) => issue.number === 25)!;
  assert.deepEqual(blocked.blockedBy, [{ repository: 'JBlaak/James', number: 24 }, { repository: 'JBlaak/switchboard', number: 121 }]);
});

test('a blocker that is one of the plan\'s own issues is not outside', async () => {
  /* When */
  const plan = await new GhCli({ run: answering(james22) }).plan('JBlaak/James', 22);

  /* Then */
  assert.equal(plan!.outside.length, 0);
});

test('stateReason NOT_PLANNED maps to closedAs not_planned', async () => {
  /* Given */
  const response = james22With(25, (node) => { node.state = 'CLOSED'; node.stateReason = 'NOT_PLANNED'; });

  /* When */
  const plan = await new GhCli({ run: answering(response) }).plan('JBlaak/James', 22);

  /* Then */
  const issue = plan!.issues.find((candidate) => candidate.number === 25)!;
  assert.deepEqual([issue.state, issue.closedAs], ['closed', 'not_planned']);
});

test('an open and a draft closing PR map their state and draft flag', async () => {
  /* Given */
  const response = james22With(25, (node) => {
    node.closedByPullRequestsReferences.nodes = [
      { number: 80, state: 'OPEN', isDraft: true, additions: 3, deletions: 1, headRefName: '25-deploy', baseRefName: 'main' },
      { number: 81, state: 'CLOSED', isDraft: false, additions: 0, deletions: 0, headRefName: '25-old', baseRefName: 'main' },
    ];
  });

  /* When */
  const plan = await new GhCli({ run: answering(response) }).plan('JBlaak/James', 22);

  /* Then */
  const issue = plan!.issues.find((candidate) => candidate.number === 25)!;
  assert.deepEqual(issue.pullRequests.map((pr) => [pr.number, pr.state, pr.draft]), [[80, 'open', true], [81, 'closed', false]]);
});

test('a plan names its parent as a breadcrumb', async () => {
  /* Given */
  const copy = structuredClone(james22) as any;
  copy.data.repository.issue.parent = { number: 1, title: 'Roadmap', repository: { nameWithOwner: 'JBlaak/James' } };

  /* When */
  const plan = await new GhCli({ run: answering(copy) }).plan('JBlaak/James', 22);

  /* Then */
  assert.deepEqual(plan!.parent, { repository: 'JBlaak/James', number: 1, title: 'Roadmap' });
});

test('an issue GitHub does not know answers null', async () => {
  /* Given */
  const run = scripted(() => ({
    code: 1,
    stdout: JSON.stringify({ data: { repository: { issue: null } }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }] }),
  }));

  /* When */
  const plan = await new GhCli({ run }).plan('JBlaak/James', 9999);

  /* Then */
  assert.equal(plan, null);
});

test('a repository\'s plans come from one search, open ones only unless closed ones are asked for', async () => {
  /* Given */
  const open = answering(switchboardPlans);
  const all = answering(switchboardPlans);

  /* When */
  await new GhCli({ run: open }).plansIn('JBlaak/switchboard', { closed: false });
  await new GhCli({ run: all }).plansIn('JBlaak/switchboard', { closed: true });

  /* Then */
  assert.equal(open.calls.length, 1);
  assert.match(queryOf(open.calls[0]), /search\(type: ISSUE_ADVANCED, query: \$search, first: 50\)/);
  assert.deepEqual(open.calls[0].slice(-2), ['-f', 'search=repo:JBlaak/switchboard is:issue is:open has:sub-issue sort:updated-desc']);
  assert.deepEqual(all.calls[0].slice(-2), ['-f', 'search=repo:JBlaak/switchboard is:issue has:sub-issue sort:updated-desc']);
});

test('the recorded plans map to summaries with counts, the current level and the number of levels', async () => {
  /* When */
  const plans = await new GhCli({ run: answering(switchboardPlans) }).plansIn('JBlaak/switchboard', { closed: true });

  /* Then */
  assert.ok(plans);
  assert.deepEqual(plans.map((plan) => plan.number), [121, 112, 70, 66]);
  assert.deepEqual(plans[0], {
    repository: 'JBlaak/switchboard', number: 121, title: 'Epic: Plan tab — an epic as a levelled flow diagram',
    state: 'open', updatedAt: '2026-10-17T19:24:09Z', open: 6, total: 6, current: 1, levels: 3,
  });
  assert.deepEqual([plans[2].state, plans[2].open, plans[2].total, plans[2].current], ['closed', 0, 8, null]);
});

test('an issue the search answers without sub-issues is not a plan', async () => {
  /* Given */
  const copy = structuredClone(switchboardPlans) as any;
  copy.data.search.nodes[1].subIssues.nodes = [];

  /* When */
  const plans = await new GhCli({ run: answering(copy) }).plansIn('JBlaak/switchboard', { closed: true });

  /* Then */
  assert.deepEqual(plans!.map((plan) => plan.number), [121, 70, 66]);
});

test('parents come from one request, once each, leaving out an issue without one', async () => {
  /* Given */
  const run = answering({ data: {
    i0: { issue: { parent: { number: 112, repository: { nameWithOwner: 'JBlaak/switchboard' } } } },
    i1: { issue: { parent: { number: 112, repository: { nameWithOwner: 'JBlaak/switchboard' } } } },
    i2: { issue: { parent: { number: 22, repository: { nameWithOwner: 'JBlaak/James' } } } },
    i3: { issue: { parent: null } },
  } });

  /* When */
  const parents = await new GhCli({ run }).parentsOf([
    { repository: 'JBlaak/switchboard', number: 114 },
    { repository: 'JBlaak/switchboard', number: 113 },
    { repository: 'JBlaak/James', number: 25 },
    { repository: 'JBlaak/James', number: 22 },
    { repository: 'JBlaak/James', number: 25 },
  ]);

  /* Then */
  assert.equal(run.calls.length, 1);
  const query = queryOf(run.calls[0]);
  assert.match(query, /i0: repository\(owner: "JBlaak", name: "switchboard"\) \{ issue\(number: 114\)/);
  assert.match(query, /i3: repository\(owner: "JBlaak", name: "James"\) \{ issue\(number: 22\)/);
  assert.doesNotMatch(query, /i4:/, 'a repeated issue is asked for once');
  assert.deepEqual(parents, [{ repository: 'JBlaak/switchboard', number: 112 }, { repository: 'JBlaak/James', number: 22 }]);
});

test('no issues need no request', async () => {
  /* Given */
  const run = answering({});

  /* When */
  const parents = await new GhCli({ run }).parentsOf([]);

  /* Then */
  assert.deepEqual(parents, []);
  assert.equal(run.calls.length, 0);
});

test('the issues PRs close come from one request, leaving out a number GitHub does not know', async () => {
  /* Given */
  const run = scripted(() => ({
    code: 1,
    stdout: JSON.stringify({
      data: { repository: {
        pr119: { number: 119, closingIssuesReferences: { nodes: [{ number: 112, repository: { nameWithOwner: 'JBlaak/switchboard' } }] } },
        pr129: { number: 129, closingIssuesReferences: { nodes: [{ number: 122, repository: { nameWithOwner: 'JBlaak/switchboard' } }] } },
        pr99999: null,
      } },
      errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a PullRequest with the number of 99999.' }],
    }),
  }));

  /* When */
  const closing = await new GhCli({ run }).closingIssues('JBlaak/switchboard', [119, 129, 99999]);

  /* Then */
  assert.equal(run.calls.length, 1);
  assert.match(queryOf(run.calls[0]), /pr119: pullRequest\(number: 119\) \{ number closingIssuesReferences/);
  assert.deepEqual(closing, [
    { number: 119, closes: [{ repository: 'JBlaak/switchboard', number: 112 }] },
    { number: 129, closes: [{ repository: 'JBlaak/switchboard', number: 122 }] },
  ]);
});

for (const [why, answer] of [['missing', missing], ['signed out', signedOut]] as const) {
  test(`every plan read answers null when gh is ${why}`, async () => {
    /* Given */
    const gh = new GhCli({ run: scripted(answer) });

    /* When */
    const answers = await Promise.all([
      gh.plan('JBlaak/James', 22),
      gh.plansIn('JBlaak/James', { closed: false }),
      gh.parentsOf([{ repository: 'JBlaak/James', number: 25 }]),
      gh.closingIssues('JBlaak/James', [49]),
    ]);

    /* Then */
    assert.deepEqual(answers, [null, null, null, null]);
  });
}

test('a repository that is not owner/repo is never written into a query', async () => {
  /* Given */
  const run = answering(james22);
  const gh = new GhCli({ run });

  /* When */
  const answers = await Promise.all([
    gh.plan('evil"/repo', 22),
    gh.plansIn('nope', { closed: false }),
    gh.parentsOf([{ repository: 'a") { x }', number: 1 }]),
  ]);

  /* Then */
  assert.deepEqual(answers, [null, null, []]);
  assert.equal(run.calls.length, 0);
});
