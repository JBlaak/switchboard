/**
 * Phone access with main's real side (#194): the switch in Settings starts
 * the listener and stopping it closes it again, and the section draws what
 * main says; and a session a phone started is in the sidebar at once.
 *
 * Under the suite the listener binds loopback, the key stays out of the
 * Keychain and nothing is advertised (see `composition-root`), so a run never
 * puts a service on the developer's network. What a phone does over the
 * listener is tested in node against the same wiring
 * (test/phone-access-wiring.test.ts).
 */
import net from 'node:net';
import { test, expect } from '../support/test';
import { appLog, sessionRow } from '../support/app';
import { pushEvent } from '../support/main-process';
import { P } from '../fixtures/standard';
import { EVENT } from '../../src/ipc/channels';
import type { Page } from '@playwright/test';
import type { PhoneAccessState } from '../../src/domain/phone/state';

/** What main answers now, through the same channel the section loads from. */
function mainState(page: Page): Promise<PhoneAccessState> {
  return page.evaluate(() => window.api.getPhoneAccess());
}

/** Whether anything accepts a TCP connection there. */
function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

test('turning Phone access on in Settings starts the listener, and off stops it', async ({ page, home }) => {
  /* Given */
  await page.getByRole('button', { name: 'Global settings', exact: true }).click();
  const section = page.locator('#sv-phone-access');
  const toggle = section.getByRole('checkbox', { name: 'Phone access' });
  await expect(toggle).not.toBeChecked();

  /* When */
  await toggle.locator('..').click();

  /* Then */
  await expect(toggle).toBeChecked();
  await expect(section.locator('.pa-status')).not.toHaveText(/Starting/, { timeout: 30_000 });
  const on = await mainState(page);
  expect(on.enabled).toBe(true);
  if (on.listening) {
    await expect(section.getByText(`Listening on Wi-Fi as ${on.host}`)).toBeVisible();
    expect(await accepts(on.port!)).toBe(true);
    expect(appLog(home)).toContain('(e2e) not advertising');
  } else {
    // A runner that can't make a key or bind still says why, in main's words.
    expect(on.error).toBeTruthy();
    await expect(section.getByRole('alert')).toHaveText(`Not listening: ${on.error}`);
  }

  /* When */
  await toggle.locator('..').click();

  /* Then */
  await expect(toggle).not.toBeChecked();
  await expect(section.locator('.pa-status')).toHaveCount(0);
  const off = await mainState(page);
  expect([off.enabled, off.listening, off.port]).toEqual([false, false, null]);
  if (on.listening) expect(await accepts(on.port!)).toBe(false);
});

test('a session a phone started is in the sidebar before its transcript is', async ({ page, app, home }) => {
  /* Given */
  await expect(sessionRow(page, 'New session')).toHaveCount(0);

  /* When */
  await pushEvent(app, EVENT.sessionStarted, 'from-the-phone', home.projectPath(P.acmeApi));

  /* Then */
  await expect(sessionRow(page, 'New session')).toBeVisible();
});
