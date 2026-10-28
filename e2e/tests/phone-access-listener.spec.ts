/**
 * Phone access with main's real side (#194): the switch in Settings starts
 * the listener and stopping it closes it again, and the section draws what
 * main says; a session a phone started is in the sidebar at once, and one
 * it archived leaves the window.
 *
 * Under the suite the listener binds loopback, the key stays out of the
 * Keychain and nothing is advertised (see `composition-root`), so a run never
 * puts a service on the developer's network. What a phone does over the
 * listener is tested in node against the same wiring
 * (test/phone-access-wiring.test.ts), and a phone's archive in
 * test/phone-archive.test.ts; this has the window's side of it.
 */
import net from 'node:net';
import { test, expect } from '../support/test';
import { appLog, openSession, sessionRow, terminalHeader } from '../support/app';
import { pushEvent } from '../support/main-process';
import { LABEL, P, S } from '../fixtures/standard';
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

test('a session a phone archived leaves the window, as archiving it here would', async ({ page, app, home }) => {
  /* Given */
  await openSession(page, home, LABEL.loginFix, S.loginFix);

  /* When */
  // What main does for a phone once the session is stopped: the row archived, then the window told.
  await page.evaluate((id) => window.api.archiveSession(id, true), S.loginFix);
  await pushEvent(app, EVENT.sessionArchived, S.loginFix);

  /* Then */
  await expect(terminalHeader(page)).toBeHidden();
  await expect(sessionRow(page, LABEL.loginFix)).toHaveCount(0);
});

test('a session archived from elsewhere leaves with confetti, as a click on its archive button would', async ({ page, app, home }) => {
  /* Given */
  // The harness launches with reduced motion on, and under it there is no confetti.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openSession(page, home, LABEL.loginFix, S.loginFix);

  /* When */
  // What main does when the session asked to be archived (or a phone did) and its turn ended.
  await page.evaluate((id) => window.api.archiveSession(id, true), S.loginFix);
  await pushEvent(app, EVENT.sessionArchived, S.loginFix);

  /* Then */
  await expect(page.locator('.confetti .confetti__piece').first()).toBeAttached();
  await expect(sessionRow(page, LABEL.loginFix)).toHaveCount(0);
});
