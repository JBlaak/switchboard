import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActiveSession } from '../src/application/model/active-session';
import { SessionRegistry } from '../src/application/model/session-registry';
import { sessionArchiver } from '../src/main/stop-session';
import { fakeRenderer, resizingPty } from './support/fakes';
import type { SessionStopper } from '../src/main/stop-session';

function harness({ alive = true } = {}) {
  const registry = new SessionRegistry();
  const renderer = fakeRenderer();
  const steps: string[] = [];
  const archiver = sessionArchiver({
    registry,
    remote: {} as SessionStopper['remote'],
    lifecycle: {
      stop: (key: string) => { steps.push(`stop ${key}`); },
      retire: (key: string) => { steps.push(`retire ${key}`); },
    } as unknown as SessionStopper['lifecycle'],
    terminals: { isAlive: () => alive } as unknown as SessionStopper['terminals'],
    repository: { setArchived: (id, archived) => { steps.push(`archived ${id} ${archived}`); } },
    renderer: {
      sessionArchived: (id) => {
        steps.push(`told the window ${id}`);
        renderer.sessionArchived(id);
      },
    },
  });
  const addSession = (id: string) => {
    registry.add(id, new ActiveSession({
      pty: resizingPty(), projectPath: '/code/app', projectFolder: '-code-app', knownTranscriptIds: new Set(),
      sessionSlug: null, isPlainTerminal: false, remote: null, openedAt: 0,
    }));
  };
  return { archiver, steps, addSession };
}

test('a phone’s archive stops the session, then archives its row, then tells the window', () => {
  /* Given */
  const h = harness();
  h.addSession('s1');

  /* When */
  const result = h.archiver.archive('s1');

  /* Then */
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(h.steps, ['stop s1', 'archived s1 true', 'told the window s1']);
});

test('a session whose process is already gone is retired rather than stopped, and still archived', () => {
  /* Given */
  const h = harness({ alive: false });
  h.addSession('s1');

  /* When */
  h.archiver.archive('s1');

  /* Then */
  assert.deepEqual(h.steps, ['retire s1', 'archived s1 true', 'told the window s1']);
});

test('a session with nothing running is only archived', () => {
  /* Given */
  const h = harness();

  /* When */
  const result = h.archiver.archive('gone');

  /* Then */
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(h.steps, ['archived gone true', 'told the window gone']);
});
