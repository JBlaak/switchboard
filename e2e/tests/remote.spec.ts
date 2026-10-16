/**
 * A remote session: the fake `ssh` dialled through the login shell, and the
 * connection card that narrates it.
 */
import { test, expect, forEachAppearance } from '../support/test';
import { expectScreen, openRemoteSession, sessionRow, terminalStatus } from '../support/app';
import { pushRemoteStatus, reconnectRequests, stubReconnectRemote } from '../support/main-process';
import { expectTerminalText, hasTerminal, terminalText } from '../support/terminal';
import { LABEL, REMOTE, S } from '../fixtures/standard';
import type { Locator, Page } from '@playwright/test';

const TARGET = `${REMOTE.user}@${REMOTE.host}:${REMOTE.dir}`;

/**
 * Stop the renderer's clock a moment from now, so the test decides when the
 * countdowns and the connected beat move on (`page.clock.fastForward`).
 * Needs `fakeTimers`.
 */
async function pauseClock(page: Page): Promise<void> {
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
}

/** The card's progress bar: a bare track with no accessible handle. */
function progressBar(page: Page): Locator {
  return page.getByTestId('remote-progress');
}

/** How long the bar's current run lasts, as the card set it. */
async function barDuration(page: Page): Promise<string> {
  return progressBar(page).evaluate(el => (el as HTMLElement).style.getPropertyValue('--rc-duration'));
}

/**
 * Tag the bar's fill, so `barRestarted` can tell whether it was replaced.
 * Replacing it is how a run restarts; with reduced motion on, as the harness
 * runs, there is no animation to read instead. A property rather than an
 * attribute, which a clone of the element would carry over.
 */
async function markBar(page: Page): Promise<void> {
  await progressBar(page).evaluate(el => { (el.firstElementChild as Element & { e2eMarked?: boolean }).e2eMarked = true; });
}

async function barRestarted(page: Page): Promise<boolean> {
  return progressBar(page).evaluate(el => !(el.firstElementChild as Element & { e2eMarked?: boolean }).e2eMarked);
}

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

test.describe('phases', () => {
  test('a disconnect takes the card down', async ({ page, home, app }) => {
    await openRemoteSession(page, home, LABEL.remoteApi, S.remoteApi);
    await expect(page.getByText('Connecting', { exact: true })).toBeVisible();
    await pushRemoteStatus(app, S.remoteApi, { phase: 'disconnected', target: TARGET });
    await expect(page.getByText('Connecting', { exact: true })).toBeHidden();
    await expect(page.getByText(TARGET, { exact: true })).toBeHidden();
  });

  test('a reconnect names its attempt', async ({ page, home, app }) => {
    await openRemoteSession(page, home, LABEL.remoteApi, S.remoteApi);
    await pushRemoteStatus(app, S.remoteApi, { phase: 'connecting', target: TARGET, attempt: 2, maxAttempts: 6 });
    await expect(page.getByText('Reconnecting', { exact: true })).toBeVisible();
    await expect(page.getByText('attempt 2 of 6', { exact: true })).toBeVisible();
    await expect(terminalStatus(page)).toHaveText('Reconnecting…');
  });

  test('a lost connection that gave up says so, with the reason', async ({ page, home, app }) => {
    await openRemoteSession(page, home, LABEL.remoteApi, S.remoteApi);
    await pushRemoteStatus(app, S.remoteApi, {
      phase: 'failed', target: TARGET, reason: 'ssh connection failed or dropped', attempts: 6, everConnected: true,
    });
    await expect(page.getByText('Lost connection', { exact: true })).toBeVisible();
    await expect(page.getByText('ssh connection failed or dropped', { exact: true })).toBeVisible();
  });

  test.describe('on the clock', () => {
    test.use({ fakeTimers: true });

    test('the connecting card counts up', async ({ page, home, app }) => {
      await openRemoteSession(page, home, LABEL.remoteApi, S.remoteApi);
      await pauseClock(page);
      await pushRemoteStatus(app, S.remoteApi, { phase: 'connecting', target: TARGET, attempt: 1, maxAttempts: 6 });
      await expect(page.getByText('attempt 1 of 6', { exact: true })).toBeVisible();
      await page.clock.fastForward(2_000);
      await expect(page.getByText('attempt 1 of 6 · 2s', { exact: true })).toBeVisible();
    });

    test('the retry countdown runs on the card and in the header', async ({ page, home, app }) => {
      await openRemoteSession(page, home, LABEL.remoteApi, S.remoteApi);
      await pauseClock(page);
      await pushRemoteStatus(app, S.remoteApi, {
        phase: 'retrying', target: TARGET, reason: 'ssh connection failed or dropped',
        attempt: 2, maxAttempts: 6, delayMs: 30_000, everConnected: true,
      });
      await expect(page.getByText('Reconnecting in 30s', { exact: true })).toHaveCount(2);
      await page.clock.fastForward(5_000);
      await expect(page.getByText('Reconnecting in 25s', { exact: true })).toHaveCount(2);
      await page.clock.fastForward(25_000);
      await expect(page.getByText('Reconnecting…', { exact: true })).toHaveCount(2);
    });

    test('a reconnect shows a green beat before the card steps aside', async ({ page, home, app }) => {
      await openRemoteSession(page, home, LABEL.remoteApi, S.remoteApi);
      await pauseClock(page);
      await pushRemoteStatus(app, S.remoteApi, { phase: 'connecting', target: TARGET, attempt: 2, maxAttempts: 6 });
      await expect(page.getByText('Reconnecting', { exact: true })).toBeVisible();
      await pushRemoteStatus(app, S.remoteApi, { phase: 'connected', target: TARGET });
      await expect(page.getByText('Connected', { exact: true })).toBeVisible();
      await page.clock.fastForward(400);
      await expect(page.getByText('Connected', { exact: true })).toBeVisible();
      await page.clock.fastForward(200);
      await expect(page.getByText('Connected', { exact: true })).toBeHidden();
      await expect(page.getByText(TARGET, { exact: true })).toBeHidden();
    });
  });
});

test.describe('progress bar', () => {
  test('restarts for each attempt, over the connect timeout or the backoff', async ({ page, home, app }) => {
    await openRemoteSession(page, home, LABEL.remoteApi, S.remoteApi);
    await expect(page.getByText('Connecting', { exact: true })).toBeVisible();
    expect(await barDuration(page)).toBe('10000ms');

    await markBar(page);
    await pushRemoteStatus(app, S.remoteApi, {
      phase: 'retrying', target: TARGET, reason: 'ssh connection failed or dropped',
      attempt: 1, maxAttempts: 6, delayMs: 4_000, everConnected: true,
    });
    await expect(page.getByText('Reconnecting in 4s', { exact: true })).toHaveCount(2);
    expect(await barDuration(page)).toBe('4000ms');
    expect(await barRestarted(page)).toBe(true);

    await markBar(page);
    await pushRemoteStatus(app, S.remoteApi, { phase: 'connecting', target: TARGET, attempt: 2, maxAttempts: 6 });
    await expect(page.getByText('attempt 2 of 6', { exact: true })).toBeVisible();
    expect(await barDuration(page)).toBe('10000ms');
    expect(await barRestarted(page)).toBe(true);
  });
});

test.describe('scrollback', () => {
  test('a drop after connecting is logged as a lost connection', async ({ page, home, app }) => {
    await openRemoteSession(page, home, LABEL.remoteApi, S.remoteApi);
    await pushRemoteStatus(app, S.remoteApi, {
      phase: 'retrying', target: TARGET, reason: 'ssh connection failed or dropped', delayMs: 30_000, everConnected: true,
    });
    await expectTerminalText(page, S.remoteApi, 'connection lost: ssh connection failed or dropped');
  });

  test('a host never reached is logged as unreachable', async ({ page, home, app }) => {
    await openRemoteSession(page, home, LABEL.remoteApi, S.remoteApi);
    await pushRemoteStatus(app, S.remoteApi, {
      phase: 'retrying', target: TARGET, reason: 'ssh connection timed out', delayMs: 30_000, everConnected: false,
    });
    await expectTerminalText(page, S.remoteApi, `could not reach ${TARGET}: ssh connection timed out`);
  });

  test('giving up is logged, as reconnecting or as connecting', async ({ page, home, app }) => {
    await openRemoteSession(page, home, LABEL.remoteApi, S.remoteApi);
    await pushRemoteStatus(app, S.remoteApi, { phase: 'failed', target: TARGET, reason: 'x', everConnected: true });
    await expectTerminalText(page, S.remoteApi, `gave up reconnecting to ${TARGET}`);
    await pushRemoteStatus(app, S.remoteApi, { phase: 'failed', target: TARGET, reason: 'x', everConnected: false });
    await expectTerminalText(page, S.remoteApi, `gave up connecting to ${TARGET}`);
  });

  test('a rejected key is logged as giving up', async ({ page, home }) => {
    const ssh = await openRemoteSession(page, home, LABEL.remoteApi, S.remoteApi);
    await ssh.println('joris@buildbox.local: Permission denied (publickey).');
    await ssh.exit(255);
    await expectTerminalText(page, S.remoteApi, `gave up connecting to ${TARGET}`);
  });

  test('a reconnect is logged, a first connect is not', async ({ page, home, app }) => {
    await openRemoteSession(page, home, LABEL.remoteApi, S.remoteApi);
    await pushRemoteStatus(app, S.remoteApi, { phase: 'connected', target: TARGET });
    await expect(page.getByText('Connecting', { exact: true })).toBeHidden();
    expect(await terminalText(page, S.remoteApi)).not.toContain('reconnected');

    await pushRemoteStatus(app, S.remoteApi, { phase: 'connecting', target: TARGET, attempt: 2, maxAttempts: 6 });
    await pushRemoteStatus(app, S.remoteApi, { phase: 'connected', target: TARGET });
    await expectTerminalText(page, S.remoteApi, 'reconnected');
  });
});

test.describe('buttons', () => {
  test('Retry now asks main to reconnect', async ({ page, home, app }) => {
    const ssh = await openRemoteSession(page, home, LABEL.remoteApi, S.remoteApi);
    await stubReconnectRemote(app, { ok: true });
    await pushRemoteStatus(app, S.remoteApi, {
      phase: 'retrying', target: TARGET, reason: 'ssh connection failed or dropped', delayMs: 30_000, everConnected: true,
    });
    await page.getByRole('button', { name: 'Retry now' }).click();
    await expect.poll(() => reconnectRequests(app)).toEqual([S.remoteApi]);
    expect(ssh.launches()).toHaveLength(1);
  });

  test('Retry now opens the session again once main has given up on it', async ({ page, home }) => {
    const ssh = await openRemoteSession(page, home, LABEL.remoteApi, S.remoteApi);
    await ssh.println('joris@buildbox.local: Permission denied (publickey).');
    await ssh.exit(255);
    await expect(page.getByText('Could not connect', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Retry now' }).click();
    await ssh.waitForLaunchCount(2);
    await expect(page.getByText('Connecting', { exact: true })).toBeVisible();
  });

  test('a connecting card offers only Stop trying', async ({ page, home }) => {
    await openRemoteSession(page, home, LABEL.remoteApi, S.remoteApi);
    await expect(page.getByText('Connecting', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop trying' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry now' })).toBeHidden();
  });

  test('Stop trying stops the session without asking', async ({ page, home }) => {
    await openRemoteSession(page, home, LABEL.remoteApi, S.remoteApi);
    await expect(page.getByText('Connecting', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Stop trying' }).click();
    await expect(terminalStatus(page)).toHaveText('Stopped');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});

test.describe('restore on boot', () => {
  test('a remote session still connected is reopened', async ({ page, home }) => {
    const ssh = await openRemoteSession(page, home, LABEL.remoteApi, S.remoteApi);
    await ssh.println('joris@buildbox:~/apps/api$ ');
    await expect(terminalStatus(page)).toHaveText('Running');
    await page.reload();
    await expect(terminalStatus(page)).toHaveText('Running');
    await expect.poll(() => hasTerminal(page, S.remoteApi)).toBe(true);
    expect(ssh.launches()).toHaveLength(1);
  });

  test('a remote session no longer running waits for a click', async ({ page, home }) => {
    const ssh = await openRemoteSession(page, home, LABEL.remoteApi, S.remoteApi);
    await page.getByRole('button', { name: 'Stop trying' }).click();
    await expect(terminalStatus(page)).toHaveText('Stopped');
    await page.reload();
    await expect(sessionRow(page, LABEL.remoteApi)).toBeVisible();
    // Restoring runs once the list has loaded; give it time to do the wrong thing.
    await page.waitForTimeout(1_000);
    expect(await hasTerminal(page, S.remoteApi)).toBe(false);
    expect(ssh.launches()).toHaveLength(1);

    await sessionRow(page, LABEL.remoteApi).click();
    await ssh.waitForLaunchCount(2);
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

  test.describe('beat', () => {
    test.use({ fakeTimers: true });

    test('remote card, connected', async ({ page, home, app }) => {
      await openRemoteSession(page, home, LABEL.remoteApi, S.remoteApi);
      await pauseClock(page);
      await pushRemoteStatus(app, S.remoteApi, { phase: 'connecting', target: TARGET, attempt: 2, maxAttempts: 6 });
      await pushRemoteStatus(app, S.remoteApi, { phase: 'connected', target: TARGET });
      await expect(page.getByText('Connected', { exact: true })).toBeVisible();
      await expectScreen(page, 'remote-connected');
    });
  });
});
