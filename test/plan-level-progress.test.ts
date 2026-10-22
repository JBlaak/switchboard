import { test } from 'node:test';
import assert from 'node:assert/strict';
import { levelBullets } from '../src/domain/plan/level-progress';

test('a level is done once every issue on it is merged, closed or not planned', () => {
  /* When */
  const bullets = levelBullets([['merged', 'closed', 'not-planned']]);

  /* Then */
  assert.deepEqual(bullets, ['done']);
});

test('a level is in progress once an issue on it is closed or has a PR', () => {
  /* When */
  const bullets = levelBullets([['merged', 'ready'], ['review', 'locked'], ['draft']]);

  /* Then */
  assert.deepEqual(bullets, ['in-progress', 'in-progress', 'in-progress']);
});

test('a level nothing has started on is open', () => {
  /* When */
  const bullets = levelBullets([['ready', 'ready'], ['locked'], []]);

  /* Then */
  assert.deepEqual(bullets, ['open', 'open', 'open']);
});

test('five levels of twenty issues are five bullets', () => {
  /* Given */
  const levels = [
    ['merged', 'merged', 'merged', 'merged'],
    ['merged', 'review', 'ready', 'ready'],
    ['locked', 'locked', 'locked', 'locked'],
    ['locked', 'locked', 'locked', 'locked'],
    ['locked', 'locked', 'locked', 'locked'],
  ] as const;

  /* When */
  const bullets = levelBullets(levels);

  /* Then */
  assert.deepEqual(bullets, ['done', 'in-progress', 'open', 'open', 'open']);
});
