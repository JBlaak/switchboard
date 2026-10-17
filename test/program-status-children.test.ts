import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ProgramStatusChildren } from '../src/domain/terminal/program-status-children';
import type { ProgramStatusReport, ProgramStatusState } from '../src/domain/terminal/osc';

/**
 * Claude CLI reports each running subagent as an OSC 7501 child record. These
 * pin the protocol's record-set rules — replace, clear with descendants, clear
 * all — and which states count as an agent still working.
 */

const report = (state: ProgramStatusState, id?: string, title?: string): ProgramStatusReport => ({
  kind: 'program-status',
  state,
  ...(id !== undefined ? { id } : {}),
  ...(title !== undefined ? { title } : {}),
});

test('a working child record is an agent', () => {
  /* Given */
  const children = new ProgramStatusChildren();

  /* When */
  const first = children.observe(report('working', 'a', 'Count files in src/domain'));

  /* Then */
  assert.deepEqual(first, [{ id: 'a', title: 'Count files in src/domain' }]);

  /* When */
  const second = children.observe(report('working', 'b', 'Count files in src/renderer'));

  /* Then */
  assert.deepEqual(second, [
    { id: 'a', title: 'Count files in src/domain' },
    { id: 'b', title: 'Count files in src/renderer' },
  ]);
  assert.equal(children.working.length, 2);
});

test('the root record is the session, not an agent', () => {
  /* Given */
  const children = new ProgramStatusChildren();

  /* When */
  const working = children.observe(report('working'));
  const blocked = children.observe(report('blocked'));

  /* Then */
  assert.equal(working, null);
  assert.equal(blocked, null);
  assert.deepEqual(children.working, []);
});

test('a repeated report changes nothing and says nothing', () => {
  /* Given */
  const children = new ProgramStatusChildren();
  children.observe(report('working', 'a', 'Explore'));

  /* When */
  const repeated = children.observe(report('working', 'a', 'Explore'));

  /* Then */
  assert.equal(repeated, null);
});

test('moving from working to blocked changes nothing and says nothing', () => {
  // Blocked is still working, so moving there is no change either.
  /* Given */
  const children = new ProgramStatusChildren();
  children.observe(report('working', 'a', 'Explore'));
  children.observe(report('working', 'a', 'Explore'));

  /* When */
  const blocked = children.observe(report('blocked', 'a', 'Explore'));

  /* Then */
  assert.equal(blocked, null);
});

test('a report replaces its record, title and all, keeping its place', () => {
  /* Given */
  const children = new ProgramStatusChildren();
  children.observe(report('working', 'a', 'First'));
  children.observe(report('working', 'b', 'Second'));

  /* When */
  const renamed = children.observe(report('working', 'a', 'First, renamed'));

  /* Then */
  assert.deepEqual(renamed, [
    { id: 'a', title: 'First, renamed' },
    { id: 'b', title: 'Second' },
  ]);

  /* When */
  const untitled = children.observe(report('working', 'a'));

  /* Then */
  assert.deepEqual(untitled, [{ id: 'a' }, { id: 'b', title: 'Second' }]);
});

test('idle, done and error records are not working', () => {
  /* Given */
  const states = ['idle', 'done', 'error'] as const;

  for (const state of states) {
    const children = new ProgramStatusChildren();
    children.observe(report('working', 'a', 'Task'));

    /* When */
    const finished = children.observe(report(state, 'a', 'Task'));

    /* Then */
    assert.deepEqual(finished, [], state);

    // …and a record that starts out finished never counted at all.
    /* When */
    const startedFinished = children.observe(report(state, 'b'));

    /* Then */
    assert.equal(startedFinished, null, state);
  }
});

test('a finished record that starts working again counts again', () => {
  /* Given */
  const children = new ProgramStatusChildren();
  children.observe(report('working', 'a'));
  children.observe(report('done', 'a'));

  /* When */
  const restarted = children.observe(report('working', 'a'));

  /* Then */
  assert.deepEqual(restarted, [{ id: 'a' }]);
});

test('nested agents count individually', () => {
  /* Given */
  const children = new ProgramStatusChildren();
  children.observe(report('working', 'a', 'Parent'));

  /* When */
  const nested = children.observe(report('working', 'a/b', 'Child'));

  /* Then */
  assert.deepEqual(nested, [
    { id: 'a', title: 'Parent' },
    { id: 'a/b', title: 'Child' },
  ]);
});

test('clear with an id removes that record and its descendants only', () => {
  /* Given */
  const children = new ProgramStatusChildren();
  children.observe(report('working', 'a'));
  children.observe(report('working', 'a/b'));
  children.observe(report('working', 'a/b/c'));
  children.observe(report('working', 'ab')); // a sibling sharing a prefix, not a child
  children.observe(report('working', 'd'));

  /* When */
  const afterChild = children.observe(report('clear', 'a/b'));

  /* Then */
  assert.deepEqual(afterChild, [{ id: 'a' }, { id: 'ab' }, { id: 'd' }]);

  /* When */
  const afterParent = children.observe(report('clear', 'a'));

  /* Then */
  assert.deepEqual(afterParent, [{ id: 'ab' }, { id: 'd' }]);
});

test('clearing an unknown id or a finished record says nothing', () => {
  /* Given */
  const children = new ProgramStatusChildren();
  children.observe(report('working', 'a'));
  children.observe(report('done', 'b'));

  /* When */
  const unknown = children.observe(report('clear', 'zzz'));
  const finished = children.observe(report('clear', 'b'));

  /* Then */
  assert.equal(unknown, null);
  assert.equal(finished, null);
  assert.deepEqual(children.working, [{ id: 'a' }]);
});

test('clear without an id removes every record', () => {
  /* Given */
  const children = new ProgramStatusChildren();
  children.observe(report('working', 'a'));
  children.observe(report('done', 'b'));
  children.observe(report('working', 'a/c'));

  /* When */
  const cleared = children.observe(report('clear'));

  /* Then */
  assert.deepEqual(cleared, []);

  // Everything really went, finished records included: b coming back is new.
  /* When */
  const returned = children.observe(report('working', 'b'));

  /* Then */
  assert.deepEqual(returned, [{ id: 'b' }]);
});

test('the sequence CLI 2.1.301 sends for two parallel subagents', () => {
  /* Given */
  const children = new ProgramStatusChildren();
  const sequence = [
    report('working', 'a2b4e2746e65ed41b', 'Count files in src/domain'),
    report('working', 'afa2f0fae6c4bd320', 'Count files in src/renderer'),
    report('clear', 'afa2f0fae6c4bd320'),
    report('clear', 'a2b4e2746e65ed41b'),
    report('clear'),
  ];

  /* When */
  const counts = sequence.map(r => children.observe(r)?.length ?? null);

  /* Then */
  assert.deepEqual(counts, [1, 2, 1, 0, null]);
});
