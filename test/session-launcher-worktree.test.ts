import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SessionRegistry } from '../src/application/model/session-registry';
import { SessionLauncher } from '../src/application/services/session-launcher';
import { fakeRenderer, fakeTerminals, fakeTimers, silentLog } from './support/fakes';
import type { SessionLauncherDeps } from '../src/application/services/session-launcher';
import type { SessionOptions } from '../src/domain/launch/session-options';

/**
 * `--worktree` needs a git repository to cut the worktree from. A project
 * folder with none — a quick session's scratch folder — has to start without
 * it, or the session does not start at all.
 */

function harness({ repos }: { repos: string[] }) {
  const terminals = fakeTerminals();
  const launcher = new SessionLauncher({
    registry: new SessionRegistry(),
    terminals,
    shells: { list: () => [], resolve: () => ({ id: 'zsh', name: 'zsh', path: '/bin/zsh' }) },
    transcripts: { listSessionIds: () => [], readSlug: () => null },
    settings: { shellProfileId: () => null },
    lifecycle: { wire() {} },
    remote: {},
    renderer: fakeRenderer(),
    questions: { settingsFor: () => null },
    git: { worktreeRoot: async (cwd: string) => (repos.includes(cwd) ? cwd : null) },
    clock: { now: () => 0 },
    timers: fakeTimers(),
    log: silentLog,
    fileExists: () => true,
  } as unknown as SessionLauncherDeps);

  /** The shell command the one spawn ran. */
  const command = (): string => terminals.spawns[0].args.at(-1) as string;

  const start = (projectPath: string, options: SessionOptions, isNew = true) =>
    launcher.open({ sessionId: 'abc', projectPath, isNew, options });

  return { start, command };
}

test('a new session in a git repository starts in a worktree', async () => {
  /* Given */
  const h = harness({ repos: ['/repo'] });

  /* When */
  const result = await h.start('/repo', { worktree: true });

  /* Then */
  assert.equal(result.ok, true);
  assert.match(h.command(), /--worktree/);
});

test('a new session outside a git repository starts without a worktree', async () => {
  /* Given */
  const h = harness({ repos: [] });

  /* When */
  const result = await h.start('/scratch', { worktree: true, worktreeName: 'fixed', chrome: true });

  /* Then */
  assert.equal(result.ok, true);
  assert.doesNotMatch(h.command(), /--worktree|fixed/);
  assert.match(h.command(), /--chrome/);
});
