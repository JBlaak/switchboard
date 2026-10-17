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
  /* When */
  const session = parse([user('hi', '2026-01-02T00:00:00.000Z')]);

  /* Then */
  assert.deepEqual(session.pullRequests, []);
});

test('pull requests are collected in first-seen order, one per URL', () => {
  /* Given */
  const lines = [
    user('hi', '2026-01-02T00:00:00.000Z'),
    prLink(12, url(12)),
    prLink(7, url(7)),
    // The CLI writes the same PR again on exit and resume.
    prLink(12, url(12)),
    prLink(30, url(30)),
    prLink(7, url(7)),
  ];

  /* When */
  const session = parse(lines);

  /* Then */
  assert.deepEqual(session.pullRequests, [
    { number: 12, url: url(12), repository: 'owner/repo' },
    { number: 7, url: url(7), repository: 'owner/repo' },
    { number: 30, url: url(30), repository: 'owner/repo' },
  ]);
});

test('malformed pr-link lines are ignored', () => {
  /* Given */
  const lines = [
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
  ];

  /* When */
  const session = parse(lines);

  /* Then */
  // Only the last one is usable; a missing repository is tolerated, not fatal.
  assert.deepEqual(session.pullRequests, [{ number: 9, url: url(9), repository: '' }]);
});

test('a pr-link timestamp does not move the session\'s modified time', () => {
  // The CLI re-emits pr-link lines, freshly timestamped, in the bookkeeping it
  // appends on exit and resume; that is not activity.

  /* Given */
  const lines = [
    user('hi', '2026-01-02T00:00:00.000Z'),
    prLink(1, url(1), '2026-01-05T00:00:00.000Z'),
  ];

  /* When */
  const session = parse(lines);

  /* Then */
  assert.equal(session.modified, '2026-01-02T00:00:00.000Z');
  assert.equal(session.created, '2026-01-02T00:00:00.000Z');
});

test('pullRequestFromLink accepts a well-formed link', () => {
  /* When */
  const pr = pullRequestFromLink({ prNumber: 429, prUrl: url(429), prRepository: 'owner/repo' });

  /* Then */
  assert.deepEqual(pr, { number: 429, url: url(429), repository: 'owner/repo' });
});

const cached: SessionPullRequest[] = [
  { number: 1, url: url(1), repository: 'owner/repo' },
  { number: 2, url: url(2), repository: '' },
];

test('decodePullRequests reads what the cache wrote', () => {
  /* When */
  const decoded = decodePullRequests(JSON.stringify(cached));

  /* Then */
  assert.deepEqual(decoded, cached);
});

test('decodePullRequests reads nothing from an empty or unreadable cache', () => {
  /* Given */
  const inputs = [null, undefined, '', 'not json', '{"number":1}'];

  for (const input of inputs) {
    /* When */
    const decoded = decodePullRequests(input);

    /* Then */
    assert.deepEqual(decoded, [], String(input));
  }
});

test('decodePullRequests drops entries that are not pull requests', () => {
  /* Given */
  const raw = JSON.stringify([null, 3, { number: 3, url: 'file:///etc' }, cached[0]]);

  /* When */
  const decoded = decodePullRequests(raw);

  /* Then */
  assert.deepEqual(decoded, [cached[0]]);
});

test('pullRequestLabel names the repository when it is known', () => {
  /* When */
  const label = pullRequestLabel({ number: 1309, url: url(1309), repository: 'owner/repo' });

  /* Then */
  assert.equal(label, 'owner/repo#1309');
});

test('pullRequestLabel is the bare number when the repository is unknown', () => {
  /* When */
  const label = pullRequestLabel({ number: 1309, url: url(1309), repository: '' });

  /* Then */
  assert.equal(label, '#1309');
});

test('pullRequestChips shows the newest two and folds the rest', () => {
  /* Given */
  const prs = [1, 2, 3, 4, 5].map(n => ({ number: n, url: url(n), repository: 'owner/repo' }));

  /* When */
  const chips = pullRequestChips(prs);

  /* Then */
  assert.deepEqual(chips.shown.map(p => p.number), [5, 4]);
  assert.deepEqual(chips.hidden.map(p => p.number), [3, 2, 1]);
  // The input is left alone.
  assert.deepEqual(prs.map(p => p.number), [1, 2, 3, 4, 5]);
});

test('pullRequestChips with two or fewer hides nothing', () => {
  /* Given */
  const two = [1, 2].map(n => ({ number: n, url: url(n), repository: '' }));

  /* When */
  const chips = pullRequestChips(two);

  /* Then */
  assert.deepEqual(chips.shown.map(p => p.number), [2, 1]);
  assert.deepEqual(chips.hidden, []);
});

test('pullRequestChips with none shows nothing', () => {
  /* Given */
  const inputs = [[], undefined];

  for (const input of inputs) {
    /* When */
    const chips = pullRequestChips(input);

    /* Then */
    assert.deepEqual(chips, { shown: [], hidden: [] });
  }
});
