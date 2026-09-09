import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NodePtyGateway, cleanChildEnv } from '../src/infrastructure/pty/node-pty-gateway';
import { fakePty, pidlessPty } from './support/fakes';
import type { PtyHandle } from '../src/application/ports/terminal-gateway';

/** One `kill()` the fake kernel saw: the pid (negative for a process group). */
type RecordedSignal = [number, NodeJS.Signals | 0];

interface Harness {
  gateway: NodePtyGateway;
  signals: RecordedSignal[];
}

/**
 * A gateway over a fake kernel.
 *
 * `alive` is the set of pids the kernel still knows about, and `throwFor` lets
 * a test make `kill` fail the way a real one does — which is the only way to
 * exercise the EPERM and no-process-group paths.
 */
function harness({
  alive = new Set<number>(),
  throwFor = null as null | ((pid: number, signal: NodeJS.Signals | 0) => void),
} = {}): Harness {
  const signals: RecordedSignal[] = [];
  const gateway = new NodePtyGateway({
    env: {},
    kill: (pid, signal) => {
      signals.push([pid, signal]);
      throwFor?.(pid, signal);
      if (signal === 0 && !alive.has(pid)) {
        const err = new Error('ESRCH') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
    },
  });
  return { gateway, signals };
}

// --- Signalling the tree, not just the shell ---

test('a stop signals the process group, not the single pid', () => {
  // The regression: node-pty's kill() signals the shell alone, but sessions run
  // as `zsh -l -i -c 'claude …'` (with a preLaunchCmd, another process again),
  // so `claude` could outlive the row that owned it.
  const h = harness({ alive: new Set([4242]) });
  assert.equal(h.gateway.signalTree(fakePty(4242), 'SIGTERM'), true);
  assert.deepEqual(h.signals, [[-4242, 'SIGTERM']]);
});

test('signalling falls back to the handle when there is no process group', () => {
  // Windows has no process groups; node-pty kills the job object there instead.
  const h = harness({ throwFor: () => { throw new Error('EPERM'); } });
  const pty = fakePty(4242);

  assert.equal(h.gateway.signalTree(pty, 'SIGTERM'), true);
  assert.deepEqual(h.signals, [[-4242, 'SIGTERM']]);
  assert.deepEqual(pty.kills, ['SIGTERM']);
});

test('signalling a handle with no pid does nothing', () => {
  const h = harness();
  assert.equal(h.gateway.signalTree(pidlessPty(), 'SIGTERM'), false);
  assert.deepEqual(h.signals, []);
});

// --- Liveness ---

test('a live pid reads alive, a reaped one does not', () => {
  const h = harness({ alive: new Set([4242]) });
  assert.equal(h.gateway.isAlive(fakePty(4242)), true);
  assert.equal(h.gateway.isAlive(fakePty(9999)), false);
  assert.equal(h.gateway.isAlive(pidlessPty()), false);
});

test('a pid we are not allowed to signal still counts as alive', () => {
  const h = harness({
    throwFor: (_pid, signal) => {
      if (signal !== 0) return;
      const err = new Error('EPERM') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    },
  });
  assert.equal(h.gateway.isAlive(fakePty(4242) as PtyHandle), true);
});

// --- The environment children inherit ---

test("Electron's own variables are stripped from a child's environment", () => {
  // They make a nested Electron app — or node-pty inside one — malfunction, and
  // a session that starts an editor or a dev server is exactly that case.
  const env = cleanChildEnv({
    PATH: '/usr/bin',
    ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_NO_ATTACH_CONSOLE: '1',
    NODE_OPTIONS: '--require foo',
    GOOGLE_API_KEY: 'secret',
    ORIGINAL_XDG_CURRENT_DESKTOP: 'GNOME',
    WT_SESSION: 'abc',
    SHELL: '/bin/zsh',
  });

  assert.deepEqual(env, { PATH: '/usr/bin', SHELL: '/bin/zsh' });
});
