import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ShellClaudeCaller } from '../src/infrastructure/claude-cli/claude-caller';
import { fakeTimers, silentLog } from './support/fakes';
import type { TerminalGateway } from '../src/application/ports/terminal-gateway';

/**
 * The real caller against a stand-in `claude`: a shell script that only the
 * home's .zshrc puts on PATH, so finding it at all means the login shell's
 * PATH was read (S3). It answers a cold call on stdout, and a warm one once
 * it has read its message from stdin, as the CLI does in stream-json.
 */

const FAKE_CLAUDE = `#!/bin/sh
echo "$$" >> "$HOME/launches"
case " $* " in
  *" --input-format stream-json "*)
    IFS= read -r line
    printf '%s\\n' "$line" > "$HOME/sent"
    echo '{"type":"system","subtype":"init"}'
    echo '{"type":"result","subtype":"success","is_error":false,"result":"warm"}'
    cat > /dev/null
    ;;
  *) echo '{"type":"result","subtype":"success","is_error":false,"result":"cold"}' ;;
esac
`;

function harness() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-claude-caller-'));
  const bin = path.join(home, 'only-in-zshrc');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  fs.writeFileSync(path.join(home, '.zshrc'), `export PATH='${bin}':"$PATH"\n`);

  const timers = fakeTimers();
  const terminals = { baseEnv: { HOME: home, PATH: '/usr/bin:/bin', USER: os.userInfo().username } } as unknown as TerminalGateway;
  const shells = {
    list: () => [],
    resolve: () => ({ id: 'zsh', name: 'zsh', path: '/bin/zsh' }),
  };
  const caller = new ShellClaudeCaller({
    shells, terminals, timers, log: silentLog, homeDir: home, shellProfileId: () => 'zsh',
  });
  const launches = (): number[] => {
    try {
      return fs.readFileSync(path.join(home, 'launches'), 'utf8').split('\n').filter(Boolean).map(Number);
    } catch {
      return [];
    }
  };
  return { home, caller, timers, launches };
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('a cold call finds claude on a PATH only the login shell\'s .zshrc sets', async () => {
  /* Given */
  const { caller } = harness();

  /* When */
  const run = await caller.call(['-p', 'hello'], new AbortController().signal);

  /* Then */
  assert.equal(run.exitCode, 0);
  assert.equal(JSON.parse(run.stdout).result, 'cold');
});

test('a warm call hands its prompt over stdin and answers with the result envelope', async () => {
  /* Given */
  const { home, caller, launches } = harness();
  const warm = caller.warm(['-p', '--model', 'haiku']);
  await until(() => launches().length === 1, 'the warm process to start');

  /* When */
  const run = await warm.send('Which project?', new AbortController().signal);

  /* Then */
  assert.deepEqual(run, {
    exitCode: 0,
    stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'warm' }) + '\n',
    stderr: '',
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'sent'), 'utf8')),
    { type: 'user', message: { role: 'user', content: 'Which project?' } });
  await until(() => !running(launches()[0]), 'the process to exit once stdin closed');
});

test('an unused warm process is killed when its idle time is up, and a send starts another', async () => {
  /* Given */
  const { caller, timers, launches } = harness();
  const warm = caller.warm(['-p']);
  await until(() => launches().length === 1, 'the warm process to start');

  /* When */
  timers.tick();
  await until(() => !running(launches()[0]), 'the idle process to be killed');
  const run = await warm.send('Still there?', new AbortController().signal);

  /* Then */
  assert.equal(JSON.parse(run.stdout).result, 'warm');
  assert.equal(launches().length, 2);
});

test('aborting a warm send kills the process', async () => {
  /* Given */
  const { caller, launches } = harness();
  const warm = caller.warm(['-p']);
  await until(() => launches().length === 1, 'the warm process to start');
  const controller = new AbortController();

  /* When */
  controller.abort();
  const run = await warm.send('Never mind', controller.signal);

  /* Then */
  assert.equal(run.exitCode, null);
  await until(() => !running(launches()[0]), 'the aborted process to be killed');
});

test('closing kills every warm process', async () => {
  /* Given */
  const { caller, launches } = harness();
  caller.warm(['-p']);
  caller.warm(['-p']);
  await until(() => launches().length === 2, 'both warm processes to start');

  /* When */
  caller.close();

  /* Then */
  await until(() => launches().every(pid => !running(pid)), 'both processes to be killed');
});
