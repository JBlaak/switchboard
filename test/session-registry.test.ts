import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ActiveSession } from '../src/application/model/active-session';
import { SessionRegistry } from '../src/application/model/session-registry';
import { fakePty } from './support/fakes';

function session(): ActiveSession {
  return new ActiveSession({
    pty: fakePty(),
    projectPath: '/repo',
    projectFolder: '-repo',
    knownTranscriptIds: new Set(),
    sessionSlug: null,
    isPlainTerminal: false,
    forkFrom: null,
    ideBridge: null,
    remote: null,
    openedAt: 0,
  });
}

test('a session is findable by an id it has been re-keyed away from', () => {
  // A fork or plan-accept re-keys the registry, and a sidebar row opened before
  // the transition still carries the old id. The regression: a stop aimed at
  // that id reported "not running" while the PTY carried on.
  const registry = new SessionRegistry();
  const held = session();
  registry.add('temp-id', held);
  registry.rekey('temp-id', 'new-id');

  assert.deepEqual(registry.find('new-id'), { key: 'new-id', session: held });
  assert.deepEqual(registry.find('temp-id'), { key: 'new-id', session: held });
  assert.equal(registry.find('unknown'), null);
});

test('re-keying records where the session came from', () => {
  const registry = new SessionRegistry();
  const held = session();
  registry.add('a', held);
  registry.rekey('a', 'b');

  assert.equal(registry.has('a'), false);
  assert.equal(registry.get('b'), held);
  assert.equal(held.realSessionId, 'b');
  assert.deepEqual([...held.priorIds ?? []], ['a']);
});

test('every id a session has answered to is reported', () => {
  const registry = new SessionRegistry();
  const held = session();
  registry.add('a', held);
  registry.rekey('a', 'b');
  registry.rekey('b', 'c');

  assert.deepEqual([...held.allIds('c')].sort(), ['a', 'b', 'c']);
});

test('a snapshot survives deletion while it is being iterated', () => {
  // Callers retire sessions as they walk the registry, and a live iterator
  // would skip entries.
  const registry = new SessionRegistry();
  registry.add('a', session());
  registry.add('b', session());

  const seen: string[] = [];
  for (const [id] of registry.snapshot()) {
    seen.push(id);
    registry.delete(id);
  }

  assert.deepEqual(seen, ['a', 'b']);
  assert.equal(registry.size, 0);
});
