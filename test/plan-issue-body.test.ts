import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { summariseIssueBody } from '../src/domain/plan/issue-body';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');

test('a James issue is summarised from its What to build section', () => {
  /* Given */
  const body = fixture('issue-body-james-44.md');

  /* When */
  const { summary, acceptance } = summariseIssueBody(body);

  /* Then */
  assert.equal(summary, 'Joris asks "heb je iets om te lezen?" in the same bar and gets one pick at a time.');
  assert.deepEqual(acceptance, [
    { text: 'Asking in the bar shows one Item with the templated line and [Open] [Iets anders] [Klaar]', done: false },
    { text: '"Iets anders" shows a different Item', done: false },
    { text: 'Opening a suggestion leaves its Status New', done: false },
    { text: 'No match shows the nothing-found line with the closest Item', done: false },
    { text: 'Offline, asking shows "Can\'t reach James right now"', done: false },
  ]);
});

test('an issue that starts with Part of is summarised from its first prose paragraph', () => {
  /* Given */
  const body = fixture('issue-body-switchboard-113.md');

  /* When */
  const { summary, acceptance } = summariseIssueBody(body);

  /* Then */
  assert.equal(summary, 'Find the images in a local diff, record how big each side is, and serve their bytes over IPC.');
  assert.deepEqual(acceptance, []);
});

test('links become their text, and stars and backticks are stripped', () => {
  /* Given */
  const body = '# Title\n\n- a list\n\n| a | table |\n\n```\ncode\n```\n\nSee **[the docs](https://x.y)** for `layOutPlan`,\nwhich *matters*.';

  /* When */
  const { summary } = summariseIssueBody(body);

  /* Then */
  assert.equal(summary, 'See the docs for layOutPlan, which matters.');
});

test('a long summary is cut to about 320 characters at a word', () => {
  /* Given */
  const body = 'word '.repeat(200);

  /* When */
  const { summary } = summariseIssueBody(body);

  /* Then */
  assert.ok(summary.length <= 320);
  assert.ok(summary.endsWith('word…'));
});

test('acceptance lines keep their order and whether they are ticked', () => {
  /* Given */
  const body = 'Text.\n\n- [x] First\n- [ ] Second\n* [X] Third\n\n```\n- [ ] not in code\n```';

  /* When */
  const { acceptance } = summariseIssueBody(body);

  /* Then */
  assert.deepEqual(acceptance, [
    { text: 'First', done: true },
    { text: 'Second', done: false },
    { text: 'Third', done: true },
  ]);
});

test('a body with no prose has an empty summary', () => {
  /* Given */
  const body = '## Heading\n\n- only a list';

  /* When */
  const { summary } = summariseIssueBody(body);

  /* Then */
  assert.equal(summary, '');
});
