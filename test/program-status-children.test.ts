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
  const children = new ProgramStatusChildren();
  assert.deepEqual(children.observe(report('working', 'a', 'Count files in src/domain')), [
    { id: 'a', title: 'Count files in src/domain' },
  ]);
  assert.deepEqual(children.observe(report('working', 'b', 'Count files in src/renderer')), [
    { id: 'a', title: 'Count files in src/domain' },
    { id: 'b', title: 'Count files in src/renderer' },
  ]);
  assert.equal(children.working.length, 2);
});

test('the root record is the session, not an agent', () => {
  const children = new ProgramStatusChildren();
  assert.equal(children.observe(report('working')), null);
  assert.equal(children.observe(report('blocked')), null);
  assert.deepEqual(children.working, []);
});

test('a repeated report changes nothing and says nothing', () => {
  const children = new ProgramStatusChildren();
  children.observe(report('working', 'a', 'Explore'));
  assert.equal(children.observe(report('working', 'a', 'Explore')), null);
  // Blocked is still working, so moving there is no change either.
  assert.equal(children.observe(report('blocked', 'a', 'Explore')), null);
});

test('a report replaces its record, title and all, keeping its place', () => {
  const children = new ProgramStatusChildren();
  children.observe(report('working', 'a', 'First'));
  children.observe(report('working', 'b', 'Second'));
  assert.deepEqual(children.observe(report('working', 'a', 'First, renamed')), [
    { id: 'a', title: 'First, renamed' },
    { id: 'b', title: 'Second' },
  ]);
  assert.deepEqual(children.observe(report('working', 'a')), [{ id: 'a' }, { id: 'b', title: 'Second' }]);
});

test('idle, done and error records are not working', () => {
  for (const state of ['idle', 'done', 'error'] as const) {
    const children = new ProgramStatusChildren();
    children.observe(report('working', 'a', 'Task'));
    assert.deepEqual(children.observe(report(state, 'a', 'Task')), [], state);
    // …and a record that starts out finished never counted at all.
    assert.equal(children.observe(report(state, 'b')), null, state);
  }
});

test('a finished record that starts working again counts again', () => {
  const children = new ProgramStatusChildren();
  children.observe(report('working', 'a'));
  children.observe(report('done', 'a'));
  assert.deepEqual(children.observe(report('working', 'a')), [{ id: 'a' }]);
});

test('nested agents count individually', () => {
  const children = new ProgramStatusChildren();
  children.observe(report('working', 'a', 'Parent'));
  assert.deepEqual(children.observe(report('working', 'a/b', 'Child')), [
    { id: 'a', title: 'Parent' },
    { id: 'a/b', title: 'Child' },
  ]);
});

test('clear with an id removes that record and its descendants only', () => {
  const children = new ProgramStatusChildren();
  children.observe(report('working', 'a'));
  children.observe(report('working', 'a/b'));
  children.observe(report('working', 'a/b/c'));
  children.observe(report('working', 'ab')); // a sibling sharing a prefix, not a child
  children.observe(report('working', 'd'));

  assert.deepEqual(children.observe(report('clear', 'a/b')), [{ id: 'a' }, { id: 'ab' }, { id: 'd' }]);
  assert.deepEqual(children.observe(report('clear', 'a')), [{ id: 'ab' }, { id: 'd' }]);
});

test('clearing an unknown id or a finished record says nothing', () => {
  const children = new ProgramStatusChildren();
  children.observe(report('working', 'a'));
  children.observe(report('done', 'b'));
  assert.equal(children.observe(report('clear', 'zzz')), null);
  assert.equal(children.observe(report('clear', 'b')), null);
  assert.deepEqual(children.working, [{ id: 'a' }]);
});

test('clear without an id removes every record', () => {
  const children = new ProgramStatusChildren();
  children.observe(report('working', 'a'));
  children.observe(report('done', 'b'));
  children.observe(report('working', 'a/c'));
  assert.deepEqual(children.observe(report('clear')), []);
  // Everything really went, finished records included: b coming back is new.
  assert.deepEqual(children.observe(report('working', 'b')), [{ id: 'b' }]);
});

test('the sequence CLI 2.1.301 sends for two parallel subagents', () => {
  const children = new ProgramStatusChildren();
  const counts = [
    report('working', 'a2b4e2746e65ed41b', 'Count files in src/domain'),
    report('working', 'afa2f0fae6c4bd320', 'Count files in src/renderer'),
    report('clear', 'afa2f0fae6c4bd320'),
    report('clear', 'a2b4e2746e65ed41b'),
    report('clear'),
  ].map(r => children.observe(r)?.length ?? null);
  assert.deepEqual(counts, [1, 2, 1, 0, null]);
});
