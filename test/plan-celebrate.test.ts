import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldCelebrate } from '../src/domain/plan/celebrate';
import { planBeat } from '../src/domain/companion/plan-beats';

test('a plan moving from level 1 to level 2 levels up to 2', () => {
  /* Given */
  const lastSeen = 1;

  /* When */
  const celebration = shouldCelebrate(lastSeen, 2, false);

  /* Then */
  assert.deepEqual(celebration, { kind: 'level-up', level: 2 });
});

test('a plan skipping a level levels up to where it is now', () => {
  /* Given */
  const lastSeen = 1;

  /* When */
  const celebration = shouldCelebrate(lastSeen, 3, false);

  /* Then */
  assert.deepEqual(celebration, { kind: 'level-up', level: 3 });
});

test('a plan cleared after a level is cleared, naming the level that cleared it', () => {
  /* Given */
  const lastSeen = 3;

  /* When */
  const celebration = shouldCelebrate(lastSeen, null, false);

  /* Then */
  assert.deepEqual(celebration, { kind: 'cleared', level: 3 });
});

test('the first sighting of a plan never celebrates, whatever its level', () => {
  /* Given */
  const firstSighting = true;

  /* When */
  const onALevel = shouldCelebrate(null, 3, firstSighting);
  const cleared = shouldCelebrate(null, null, firstSighting);

  /* Then */
  assert.deepEqual(onALevel, { kind: 'none' });
  assert.deepEqual(cleared, { kind: 'none' });
});

test('the same level again does not celebrate', () => {
  /* Given */
  const lastSeen = 2;

  /* When */
  const celebration = shouldCelebrate(lastSeen, 2, false);

  /* Then */
  assert.deepEqual(celebration, { kind: 'none' });
});

test('a level going back down when an issue reopens does not celebrate', () => {
  /* Given */
  const lastSeen = 3;

  /* When */
  const celebration = shouldCelebrate(lastSeen, 2, false);

  /* Then */
  assert.deepEqual(celebration, { kind: 'none' });
});

test('a cleared plan reopening does not celebrate', () => {
  /* Given */
  const lastSeen = null;

  /* When */
  const celebration = shouldCelebrate(lastSeen, 2, false);

  /* Then */
  assert.deepEqual(celebration, { kind: 'none' });
});

test('Patch cheers on to the next level', () => {
  /* Given */
  const moment = { kind: 'level-up', level: 2, levels: 3 } as const;

  /* When */
  const beat = planBeat(moment);

  /* Then */
  assert.deepEqual(beat, { move: 'hop', mood: 'happy', line: 'Level up! On to level 2.' });
});

test('Patch says when the plan reached its last level', () => {
  /* Given */
  const moment = { kind: 'level-up', level: 3, levels: 3 } as const;

  /* When */
  const beat = planBeat(moment);

  /* Then */
  assert.deepEqual(beat, { move: 'twirl', mood: 'happy', line: 'Level up! Last level: 3 of 3.' });
});

test('Patch celebrates a cleared plan, a one-level one in its own words', () => {
  /* Given */
  const levels = [3, 1];

  /* When */
  const [many, one] = levels.map(n => planBeat({ kind: 'cleared', levels: n }));

  /* Then */
  assert.deepEqual(many, { move: 'love', mood: 'happy', line: 'Plan cleared! Every last one.' });
  assert.deepEqual(one, { move: 'love', mood: 'happy', line: 'Plan cleared! That’s the lot.' });
});
