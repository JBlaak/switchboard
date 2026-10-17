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
  /* Given */
  const h = harness({ alive: new Set([4242]) });

  /* When */
  const signalled = h.gateway.signalTree(fakePty(4242), 'SIGTERM');

  /* Then */
  assert.equal(signalled, true);
  assert.deepEqual(h.signals, [[-4242, 'SIGTERM']]);
});

test('signalling falls back to the handle when there is no process group', () => {
  // When the group cannot be signalled, the shell itself still gets the signal.
  /* Given */
  const h = harness({ throwFor: () => { throw new Error('EPERM'); } });
  const pty = fakePty(4242);

  /* When */
  const signalled = h.gateway.signalTree(pty, 'SIGTERM');

  /* Then */
  assert.equal(signalled, true);
  assert.deepEqual(h.signals, [[-4242, 'SIGTERM']]);
  assert.deepEqual(pty.kills, ['SIGTERM']);
});

test('signalling a handle with no pid does nothing', () => {
  /* Given */
  const h = harness();

  /* When */
  const signalled = h.gateway.signalTree(pidlessPty(), 'SIGTERM');

  /* Then */
  assert.equal(signalled, false);
  assert.deepEqual(h.signals, []);
});

// --- Liveness ---

test('a live pid reads alive, a reaped one does not', () => {
  /* Given */
  const h = harness({ alive: new Set([4242]) });

  /* When */
  const live = h.gateway.isAlive(fakePty(4242));
  const reaped = h.gateway.isAlive(fakePty(9999));
  const pidless = h.gateway.isAlive(pidlessPty());

  /* Then */
  assert.equal(live, true);
  assert.equal(reaped, false);
  assert.equal(pidless, false);
});

test('a pid we are not allowed to signal still counts as alive', () => {
  /* Given */
  const h = harness({
    throwFor: (_pid, signal) => {
      if (signal !== 0) return;
      const err = new Error('EPERM') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    },
  });

  /* When */
  const alive = h.gateway.isAlive(fakePty(4242) as PtyHandle);

  /* Then */
  assert.equal(alive, true);
});

// --- The environment children inherit ---

test("Electron's own variables are stripped from a child's environment", () => {
  // They make a nested Electron app — or node-pty inside one — malfunction, and
  // a session that starts an editor or a dev server is exactly that case.
  /* Given */
  const parentEnv = {
    PATH: '/usr/bin',
    ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_NO_ATTACH_CONSOLE: '1',
    NODE_OPTIONS: '--require foo',
    GOOGLE_API_KEY: 'secret',
    ORIGINAL_XDG_CURRENT_DESKTOP: 'GNOME',
    WT_SESSION: 'abc',
    SHELL: '/bin/zsh',
  };

  /* When */
  const env = cleanChildEnv(parentEnv);

  /* Then */
  assert.deepEqual(env, { PATH: '/usr/bin', SHELL: '/bin/zsh' });
});

test("A Claude Code parent's markers are stripped from a child's environment", () => {
  // Switchboard started from inside a Claude Code session inherits them, and a
  // session that sees CLAUDE_CODE_CHILD_SESSION turns its transcript saving off.
  /* Given */
  const parentEnv = {
    PATH: '/usr/bin',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDECODE: '1',
  };

  /* When */
  const env = cleanChildEnv(parentEnv);

  /* Then */
  assert.deepEqual(env, { PATH: '/usr/bin' });
});
