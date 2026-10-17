import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GhCli, type GhResult, type GhRunner } from '../src/infrastructure/github/gh-cli';
import recorded from './fixtures/gh-pull-requests.json';

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

/** gh exits 1 when a GraphQL response carries errors, even next to data. */
const partial = (): Partial<GhResult> => ({
  code: 1,
  stdout: JSON.stringify(recorded),
  stderr: 'gh: Could not resolve to a PullRequest with the number of 99.\n',
});

const missing = (): Partial<GhResult> => ({ missing: true, code: null });
const signedOut = (): Partial<GhResult> => ({
  code: 4,
  stderr: 'To get started with GitHub CLI, please run:  gh auth login\n',
});
const revoked = (): Partial<GhResult> => ({
  code: 1,
  stdout: '{"message":"Bad credentials","status":"401"}',
  stderr: 'gh: Bad credentials (HTTP 401)\n',
});

test('all PRs of a repository come from one GraphQL call with an alias each, as argv', async () => {
  const run = scripted(partial);
  await new GhCli({ run }).pullRequests('acme/web', [12, 13, 14, 99, 12]);

  assert.equal(run.calls.length, 1);
  const args = run.calls[0];
  assert.deepEqual(args.slice(0, 3), ['api', 'graphql', '-f']);
  const query = args[3];
  for (const n of [12, 13, 14, 99]) assert.match(query, new RegExp(`pr${n}: pullRequest\\(number: ${n}\\)`));
  assert.equal(query.match(/pr12:/g)?.length, 1, 'a repeated number is asked for once');
  assert.match(query, /viewer \{ login \}/);
  assert.deepEqual(args.slice(4), ['-f', 'owner=acme', '-f', 'name=web']);
});

test('a recorded response maps to PR statuses, leaving out the number GitHub does not know', async () => {
  const prs = await new GhCli({ run: scripted(partial) }).pullRequests('acme/web', [12, 13, 14, 99]);
  assert.ok(prs);
  assert.deepEqual(prs.map((pr) => pr.number), [12, 13, 14]);

  const [open, draft, merged] = prs;
  assert.equal(open.state, 'open');
  assert.equal(open.title, 'Add the billing page');
  assert.equal(open.url, 'https://github.com/acme/web/pull/12');
  assert.equal(open.repository, 'acme/web');
  assert.equal(open.headRef, 'feat/12-billing');
  assert.equal(open.headSha, 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
  assert.equal(open.baseRef, 'main');
  assert.equal(open.mergeable, 'mergeable');
  assert.deepEqual([open.additions, open.deletions], [120, 14]);
  assert.equal(draft.additions, undefined, 'a count GitHub did not send stays unknown');
  assert.deepEqual(open.closes, [
    { repository: 'acme/web', number: 7 },
    { repository: 'acme/api', number: 3 },
  ]);

  assert.equal(draft.state, 'draft');
  assert.equal(draft.mergeable, 'conflicting');
  assert.deepEqual(draft.checks, []);

  assert.equal(merged.state, 'merged');
  assert.equal(merged.mergeable, 'unknown');
});

test('check runs and status contexts fold into the four states', async () => {
  const [pr] = (await new GhCli({ run: scripted(partial) }).pullRequests('acme/web', [12]))!;
  assert.deepEqual(pr.checks, [
    { name: 'test', state: 'failing', url: 'https://github.com/acme/web/actions/runs/111/job/222' },
    { name: 'e2e', state: 'pending', url: 'https://github.com/acme/web/actions/runs/111/job/223' },
    { name: 'publish', state: 'skipped', url: 'https://github.com/acme/web/actions/runs/111/job/224' },
    { name: 'lint', state: 'failing' },
    { name: 'vercel', state: 'passing', url: 'https://vercel.com/acme/web/abc' },
  ]);
});

test('behindBy is known for a PR on the default branch, and unknown on another base or with the branch gone', async () => {
  const prs = (await new GhCli({ run: scripted(partial) }).pullRequests('acme/web', [12, 13, 14]))!;
  assert.equal(prs[0].behindBy, 3);
  assert.equal(prs[1].behindBy, undefined, 'based on release/2.1, not main');
  assert.equal(prs[2].behindBy, undefined, 'merged and its branch deleted');
});

test('review threads carry author, bot flag, path, line, side and resolution; needsYou is your open last word', async () => {
  const [pr] = (await new GhCli({ run: scripted(partial) }).pullRequests('acme/web', [12]))!;
  const threads = new Map(pr.threads!.map((thread) => [thread.id, thread]));

  assert.deepEqual([...threads.keys()], ['PRRT_bot', 'PRRT_app', 'PRRT_needs_you', 'PRRT_resolved', 'PRRT_waiting'],
    'a thread of nothing but your pending comments is not a thread yet');

  const bot = threads.get('PRRT_bot')!;
  assert.deepEqual(bot.comments, [{
    author: 'coderabbitai', isBot: true, body: 'Possible null dereference.', createdAt: '2026-10-16T09:00:00Z',
  }]);
  assert.equal(bot.path, 'src/billing.ts');
  assert.equal(bot.line, 40);
  assert.equal(bot.side, 'RIGHT');
  assert.equal(bot.needsYou, false);

  assert.equal(threads.get('PRRT_app')!.comments[0].isBot, true, 'an app account by its [bot] login');

  const needsYou = threads.get('PRRT_needs_you')!;
  assert.equal(needsYou.side, 'LEFT');
  assert.equal(needsYou.resolved, false);
  assert.equal(needsYou.needsYou, true);
  assert.deepEqual(needsYou.comments.map((c) => [c.author, c.isBot]), [['sam', false], ['joris', false]]);

  const resolved = threads.get('PRRT_resolved')!;
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.line, null, 'an outdated line is null');
  assert.equal(resolved.needsYou, false, 'resolved, so nothing waits on you even though you spoke last');

  assert.equal(threads.get('PRRT_waiting')!.needsYou, false, 'a reviewer spoke last: it waits on Claude');
});

test('your pending review comes back with each comment\'s side', async () => {
  const [pr] = (await new GhCli({ run: scripted(partial) }).pullRequests('acme/web', [12]))!;
  assert.deepEqual(pr.pendingReview, [
    { path: 'src/billing.ts', line: 8, side: 'LEFT', body: 'Why was this removed?' },
    { path: 'src/billing.ts', line: 61, side: 'RIGHT', body: 'Typo in the label.' },
  ]);
});

test('missing gh: available says so and every call answers null without throwing', async () => {
  const gh = new GhCli({ run: scripted(missing) });
  assert.equal(await gh.available(), 'missing');
  assert.equal(await gh.pullRequests('acme/web', [12]), null);
  assert.equal(await gh.pullRequestDiff('acme/web', 12), null);
  assert.equal(await gh.checkLogTail('acme/web', 'https://github.com/acme/web/actions/runs/1/job/2', 50), null);
  assert.equal(await gh.issues('acme/web', [7]), null);
});

test('signed out or revoked: available says unauthenticated and every call answers null', async () => {
  for (const answer of [signedOut, revoked]) {
    const gh = new GhCli({ run: scripted(answer) });
    assert.equal(await gh.available(), 'unauthenticated');
    assert.equal(await gh.pullRequests('acme/web', [12]), null);
    assert.equal(await gh.pullRequestDiff('acme/web', 12), null);
    assert.equal(await gh.checkLogTail('acme/web', 'https://github.com/acme/web/actions/runs/1/job/2', 50), null);
    assert.equal(await gh.issues('acme/web', [7]), null);
  }
});

test('available is ok when gh auth status passes', async () => {
  const run = scripted(() => ({ code: 0 }));
  assert.equal(await new GhCli({ run }).available(), 'ok');
  assert.deepEqual(run.calls[0], ['auth', 'status', '--hostname', 'github.com']);
});

test('a malformed repository or no numbers asks nothing', async () => {
  const run = scripted(partial);
  const gh = new GhCli({ run });
  assert.equal(await gh.pullRequests('not a repo', [1]), null);
  assert.equal(await gh.pullRequests('acme/web; rm -rf /', [1]), null);
  assert.deepEqual(await gh.pullRequests('acme/web', []), []);
  assert.deepEqual(await gh.issues('acme/web', [0, -1, 1.5]), []);
  assert.equal(run.calls.length, 0);
});

test('issues keeps only what GitHub confirms is an issue', async () => {
  const run = scripted(() => ({
    code: 1,
    stdout: JSON.stringify({
      data: {
        repository: {
          i7: { __typename: 'Issue', number: 7, title: 'Billing page', state: 'OPEN', url: 'https://github.com/acme/web/issues/7' },
          i8: { __typename: 'Issue', number: 8, title: 'Old bug', state: 'CLOSED', url: 'https://github.com/acme/web/issues/8' },
          i12: { __typename: 'PullRequest' },
          i404: null,
        },
      },
      errors: [{ type: 'NOT_FOUND', path: ['repository', 'i404'], message: 'Could not resolve to an issue or pull request with the number of 404.' }],
    }),
  }));
  const issues = await new GhCli({ run }).issues('acme/web', [7, 8, 12, 404]);
  assert.deepEqual(issues, [
    { repository: 'acme/web', number: 7, title: 'Billing page', state: 'open', url: 'https://github.com/acme/web/issues/7' },
    { repository: 'acme/web', number: 8, title: 'Old bug', state: 'closed', url: 'https://github.com/acme/web/issues/8' },
  ]);
  assert.equal(run.calls.length, 1, 'one call for every number');
  assert.match(run.calls[0][3], /i12: issueOrPullRequest\(number: 12\)/);
});

test('pullRequestDiff runs gh pr diff with plain output', async () => {
  const run = scripted(() => ({ stdout: 'diff --git a/x b/x\n' }));
  assert.equal(await new GhCli({ run }).pullRequestDiff('acme/web', 12), 'diff --git a/x b/x\n');
  assert.deepEqual(run.calls[0], ['pr', 'diff', '12', '--repo', 'acme/web', '--color', 'never']);
});

test('checkLogTail reads the failed steps of an Actions job, without gh\'s prefixes', async () => {
  const log = [
    'test\tRun tests\t2026-10-16T09:00:00.0000000Z > switchboard@2.2.0 test',
    'test\tRun tests\t2026-10-16T09:00:01.0000000Z not ok 3 - parses a rename',
    'test\tRun tests\t2026-10-16T09:00:02.0000000Z ##[error]Process completed with exit code 1.',
    '',
  ].join('\n');
  const run = scripted((args) => (args.includes('--log-failed') ? { stdout: log } : { code: 1 }));
  const tail = await new GhCli({ run }).checkLogTail('acme/web', 'https://github.com/acme/web/actions/runs/111/job/222', 2);
  assert.equal(tail, 'not ok 3 - parses a rename\n##[error]Process completed with exit code 1.');
  assert.deepEqual(run.calls[0], ['run', 'view', '--repo', 'acme/web', '--job', '222', '--log-failed']);
});

test('checkLogTail falls back to the whole log, and answers null for a check that is not an Actions job', async () => {
  const run = scripted((args) => (args.includes('--log') ? { stdout: 'build\tSet up\t2026-10-16T09:00:00Z hello\n' } : { stdout: '' }));
  const gh = new GhCli({ run });
  assert.equal(await gh.checkLogTail('acme/web', 'https://github.com/acme/web/runs/555', 10), 'hello');
  assert.equal(run.calls[1][5], '555');
  assert.equal(await gh.checkLogTail('acme/web', 'https://vercel.com/acme/web/abc', 10), null);
});
