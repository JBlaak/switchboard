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
    remote: null,
    openedAt: 0,
  });
}

function rekeyed(): { registry: SessionRegistry; held: ActiveSession } {
  const registry = new SessionRegistry();
  const held = session();
  registry.add('temp-id', held);
  registry.rekey('temp-id', 'new-id');
  return { registry, held };
}

test('a session is findable by an id it has been re-keyed away from', () => {
  // A fork or plan-accept re-keys the registry, and a sidebar row opened before
  // the transition still carries the old id. The regression: a stop aimed at
  // that id reported "not running" while the PTY carried on.

  /* Given */
  const { registry, held } = rekeyed();

  /* When */
  const found = registry.find('temp-id');

  /* Then */
  assert.deepEqual(found, { key: 'new-id', session: held });
});

test('a re-keyed session is findable by its new id', () => {
  /* Given */
  const { registry, held } = rekeyed();

  /* When */
  const found = registry.find('new-id');

  /* Then */
  assert.deepEqual(found, { key: 'new-id', session: held });
});

test('an id no session has answered to finds nothing', () => {
  /* Given */
  const { registry } = rekeyed();

  /* When */
  const found = registry.find('unknown');

  /* Then */
  assert.equal(found, null);
});

test('re-keying records where the session came from', () => {
  /* Given */
  const registry = new SessionRegistry();
  const held = session();
  registry.add('a', held);

  /* When */
  registry.rekey('a', 'b');

  /* Then */
  assert.equal(registry.has('a'), false);
  assert.equal(registry.get('b'), held);
  assert.equal(held.realSessionId, 'b');
  assert.deepEqual([...held.priorIds ?? []], ['a']);
});

test('every id a session has answered to is reported', () => {
  /* Given */
  const registry = new SessionRegistry();
  const held = session();
  registry.add('a', held);
  registry.rekey('a', 'b');
  registry.rekey('b', 'c');

  /* When */
  const ids = [...held.allIds('c')].sort();

  /* Then */
  assert.deepEqual(ids, ['a', 'b', 'c']);
});

test('a snapshot survives deletion while it is being iterated', () => {
  // Callers retire sessions as they walk the registry, and a live iterator
  // would skip entries.

  /* Given */
  const registry = new SessionRegistry();
  registry.add('a', session());
  registry.add('b', session());

  /* When */
  const seen: string[] = [];
  for (const [id] of registry.snapshot()) {
    seen.push(id);
    registry.delete(id);
  }

  /* Then */
  assert.deepEqual(seen, ['a', 'b']);
  assert.equal(registry.size, 0);
});
