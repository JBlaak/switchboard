/**
 * A remote session: the fake `ssh` dialled through the login shell, and the
 * connection card that narrates it.
 */
import { test, expect, forEachAppearance } from '../support/test';
import { expectScreen, openRemoteSession, terminalStatus } from '../support/app';
import { pushRemoteStatus } from '../support/main-process';
import { LABEL, REMOTE, S } from '../fixtures/standard';

const TARGET = `${REMOTE.user}@${REMOTE.host}:${REMOTE.dir}`;

test.describe('smoke', () => {
  test('dials the host over ssh into tmux and shows the connecting card', async ({ page, home }) => {
    const ssh = await openRemoteSession(page, home, LABEL.remoteApi, S.remoteApi);
    const launch = await ssh.launched();
    expect(launch.argv).toContain(`${REMOTE.user}@${REMOTE.host}`);
    expect(launch.argv.at(-1)).toContain('tmux attach-session');

    await expect(page.getByText('Connecting', { exact: true })).toBeVisible();
    await expect(page.getByText(TARGET, { exact: true })).toBeVisible();
    await expect(terminalStatus(page)).toHaveText('Connecting…');
  });

  test('output from the far end connects', async ({ page, home }) => {
    const ssh = await openRemoteSession(page, home, LABEL.remoteApi, S.remoteApi);
    await expect(page.getByText('Connecting', { exact: true })).toBeVisible();
    await ssh.println('joris@buildbox:~/apps/api$ ');
    await expect(page.getByText('Connecting', { exact: true })).toBeHidden();
    await expect(terminalStatus(page)).toHaveText('Running');
  });

  test('a rejected key gives up instead of retrying', async ({ page, home }) => {
    const ssh = await openRemoteSession(page, home, LABEL.remoteApi, S.remoteApi);
    await ssh.println('joris@buildbox.local: Permission denied (publickey).');
    await ssh.exit(255);
    await expect(page.getByText('Could not connect', { exact: true })).toBeVisible();
    await expect(page.getByText('the host rejected the connection', { exact: true })).toBeVisible();
  });

  test('a dropped link schedules a reconnect and dials again', async ({ page, home }) => {
    const ssh = await openRemoteSession(page, home, LABEL.remoteApi, S.remoteApi);
    await ssh.println('connected');
    await ssh.exit(255);
    // The first retry waits a second, then a new ssh is spawned.
    await ssh.waitForLaunchCount(2);
    await expect(page.getByText('Reconnecting', { exact: true })).toBeVisible();
  });
});

forEachAppearance(() => {
  test('remote card, connecting', async ({ page, home }) => {
    await openRemoteSession(page, home, LABEL.remoteApi, S.remoteApi);
    await expect(page.getByText('Connecting', { exact: true })).toBeVisible();
    await expectScreen(page, 'remote-connecting');
  });

  test('remote card, retrying', async ({ page, home, app }) => {
    await openRemoteSession(page, home, LABEL.remoteApi, S.remoteApi);
    await pushRemoteStatus(app, S.remoteApi, {
      phase: 'retrying', target: TARGET, reason: 'ssh connection failed or dropped',
      attempt: 2, maxAttempts: 6, delayMs: 30_000, everConnected: true,
    });
    // Said twice: on the card, and as the header's status.
    await expect(page.getByText('Reconnecting in 30s', { exact: true })).toHaveCount(2);
    await expect(terminalStatus(page)).toHaveText('Reconnecting in 30s');
    await expectScreen(page, 'remote-retrying');
  });

  test('remote card, failed', async ({ page, home, app }) => {
    await openRemoteSession(page, home, LABEL.remoteApi, S.remoteApi);
    await pushRemoteStatus(app, S.remoteApi, {
      phase: 'failed', target: TARGET, reason: 'the host rejected the connection', attempts: 1,
    });
    await expect(page.getByText('Could not connect', { exact: true })).toBeVisible();
    await expectScreen(page, 'remote-failed');
  });
});
