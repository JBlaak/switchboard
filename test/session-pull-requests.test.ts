import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript } from '../src/domain/session/transcript';
import {
  decodePullRequests, pullRequestChips, pullRequestFromLink, pullRequestLabel,
} from '../src/domain/session/pull-requests';
import type { SessionPullRequest } from '../src/domain/session/session';

const IDENTITY = { sessionId: 's1', folder: 'f1', projectPath: '/p' };
const TIMES = { birthtime: '2026-01-01T00:00:00.000Z', mtime: '2026-01-09T00:00:00.000Z' };

function user(text: string, timestamp: string): string {
  return JSON.stringify({ type: 'user', timestamp, message: { role: 'user', content: text } });
}

function prLink(prNumber: unknown, prUrl: unknown, timestamp = '2026-01-02T00:00:00.000Z',
  prRepository: unknown = 'owner/repo'): string {
  return JSON.stringify({ type: 'pr-link', sessionId: 's1', prNumber, prUrl, prRepository, timestamp });
}

const url = (n: number) => `https://github.com/owner/repo/pull/${n}`;

function parse(lines: string[]) {
  const session = parseTranscript(lines, IDENTITY, TIMES);
  assert.ok(session);
  return session;
}

test('a transcript without pr-link lines has no pull requests', () => {
  assert.deepEqual(parse([user('hi', '2026-01-02T00:00:00.000Z')]).pullRequests, []);
});

test('pull requests are collected in first-seen order, one per URL', () => {
  const session = parse([
    user('hi', '2026-01-02T00:00:00.000Z'),
    prLink(12, url(12)),
    prLink(7, url(7)),
    // The CLI writes the same PR again on exit and resume.
    prLink(12, url(12)),
    prLink(30, url(30)),
    prLink(7, url(7)),
  ]);
  assert.deepEqual(session.pullRequests, [
    { number: 12, url: url(12), repository: 'owner/repo' },
    { number: 7, url: url(7), repository: 'owner/repo' },
    { number: 30, url: url(30), repository: 'owner/repo' },
  ]);
});

test('malformed pr-link lines are ignored', () => {
  const session = parse([
    user('hi', '2026-01-02T00:00:00.000Z'),
    prLink(undefined, url(1)),
    prLink('5', url(5)),
    prLink(1.5, url(1)),
    prLink(0, url(0)),
    prLink(-3, url(3)),
    prLink(4, 'http://github.com/owner/repo/pull/4'),
    prLink(4, 'javascript:alert(1)'),
    prLink(4, undefined),
    prLink(9, url(9), undefined, 42),
  ]);
  // Only the last one is usable; a missing repository is tolerated, not fatal.
  assert.deepEqual(session.pullRequests, [{ number: 9, url: url(9), repository: '' }]);
});

test('a pr-link timestamp does not move the session\'s modified time', () => {
  // The CLI re-emits pr-link lines, freshly timestamped, in the bookkeeping it
  // appends on exit and resume; that is not activity.
  const session = parse([
    user('hi', '2026-01-02T00:00:00.000Z'),
    prLink(1, url(1), '2026-01-05T00:00:00.000Z'),
  ]);
  assert.equal(session.modified, '2026-01-02T00:00:00.000Z');
  assert.equal(session.created, '2026-01-02T00:00:00.000Z');
});

test('pullRequestFromLink accepts a well-formed link', () => {
  assert.deepEqual(
    pullRequestFromLink({ prNumber: 429, prUrl: url(429), prRepository: 'owner/repo' }),
    { number: 429, url: url(429), repository: 'owner/repo' });
});

test('decodePullRequests reads what the cache wrote, and nothing else', () => {
  const prs: SessionPullRequest[] = [
    { number: 1, url: url(1), repository: 'owner/repo' },
    { number: 2, url: url(2), repository: '' },
  ];
  assert.deepEqual(decodePullRequests(JSON.stringify(prs)), prs);
  assert.deepEqual(decodePullRequests(null), []);
  assert.deepEqual(decodePullRequests(undefined), []);
  assert.deepEqual(decodePullRequests(''), []);
  assert.deepEqual(decodePullRequests('not json'), []);
  assert.deepEqual(decodePullRequests('{"number":1}'), []);
  assert.deepEqual(
    decodePullRequests(JSON.stringify([null, 3, { number: 3, url: 'file:///etc' }, prs[0]])),
    [prs[0]]);
});

test('pullRequestLabel names the repository when it is known', () => {
  assert.equal(pullRequestLabel({ number: 1309, url: url(1309), repository: 'owner/repo' }), 'owner/repo#1309');
  assert.equal(pullRequestLabel({ number: 1309, url: url(1309), repository: '' }), '#1309');
});

test('pullRequestChips shows the newest two and folds the rest', () => {
  const prs = [1, 2, 3, 4, 5].map(n => ({ number: n, url: url(n), repository: 'owner/repo' }));
  const chips = pullRequestChips(prs);
  assert.deepEqual(chips.shown.map(p => p.number), [5, 4]);
  assert.deepEqual(chips.hidden.map(p => p.number), [3, 2, 1]);
  // The input is left alone.
  assert.deepEqual(prs.map(p => p.number), [1, 2, 3, 4, 5]);
});

test('pullRequestChips with two or fewer hides nothing', () => {
  const two = [1, 2].map(n => ({ number: n, url: url(n), repository: '' }));
  assert.deepEqual(pullRequestChips(two).shown.map(p => p.number), [2, 1]);
  assert.deepEqual(pullRequestChips(two).hidden, []);
  assert.deepEqual(pullRequestChips([]), { shown: [], hidden: [] });
  assert.deepEqual(pullRequestChips(undefined), { shown: [], hidden: [] });
});
