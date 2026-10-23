/**
 * Phone access on the Mac (#194): the terminal placeholder for a session a
 * phone has, and the settings, indicator and pairing confirmation drawn from
 * main's snapshot.
 *
 * Main's Phone access is stood in for here: its channels are answered by a
 * recording stub and its pushes sent directly, so these check what the
 * renderer draws and asks for. The rules behind the drawing — the slice, the
 * copy, what each control calls — are unit tested
 * (test/phone-access-slice.test.ts, test/phone-access-actions.test.ts).
 */
import { test, expect } from '../support/test';
import { openSession, sidebar } from '../support/app';
import { pushEvent } from '../support/main-process';
import { answerDialogs, dialogsAsked } from '../support/native-dialogs';
import { terminalState } from '../support/terminal';
import { LABEL, S } from '../fixtures/standard';
import { FIXTURE_NOW } from '../support/fixture-home';
import { EVENT, INVOKE } from '../../src/ipc/channels';
import { PHONE_ACCESS_OFF } from '../../src/domain/phone/state';
import type { ElectronApplication, Page } from '@playwright/test';
import type { PhoneAccessState } from '../../src/domain/phone/state';

const PIXEL = { kind: 'device', deviceId: 'd1', name: 'Pixel 9 Pro' } as const;

const LISTENING: PhoneAccessState = {
  ...PHONE_ACCESS_OFF,
  enabled: true,
  listening: true,
  host: 'joris-mbp.local',
  port: 48231,
  devices: [
    { id: 'd1', name: 'Pixel 9 Pro', pairedAt: FIXTURE_NOW - 3_600_000, lastSeenAt: FIXTURE_NOW, connected: true },
    { id: 'd2', name: 'Pixel Tablet', pairedAt: FIXTURE_NOW - 20 * 86_400_000, lastSeenAt: FIXTURE_NOW - 4 * 86_400_000, connected: false },
  ],
};

type Calls = [string, ...unknown[]][];

/**
 * Answer main's Phone access channels: each call is recorded and answered
 * with the snapshot last pushed (Use here with `{ ok: true }`), as main would
 * answer it.
 */
async function stubPhoneAccess(app: ElectronApplication, snapshot: PhoneAccessState): Promise<void> {
  const channels = {
    getPhoneAccess: INVOKE.phoneAccessGet,
    setPhoneAccessEnabled: INVOKE.phoneAccessSetEnabled,
    startPhonePairing: INVOKE.phoneAccessStartPairing,
    stopPhonePairing: INVOKE.phoneAccessStopPairing,
    confirmPhonePairing: INVOKE.phoneAccessConfirmPairing,
    revokePhoneDevice: INVOKE.phoneAccessRevoke,
    resetPhoneIdentity: INVOKE.phoneAccessReset,
    useTerminalHere: INVOKE.useTerminalHere,
  };
  await app.evaluate(({ ipcMain }, { channels, snapshot }) => {
    const state = globalThis as typeof globalThis & { __phoneCalls: [string, ...unknown[]][]; __phoneSnapshot: unknown };
    state.__phoneCalls = [];
    state.__phoneSnapshot = snapshot;
    for (const [method, channel] of Object.entries(channels)) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (_event, ...args) => {
        state.__phoneCalls.push([method, ...args]);
        return method === 'useTerminalHere' ? { ok: true } : state.__phoneSnapshot;
      });
    }
  }, { channels, snapshot });
}

/** Main's snapshot changed: what its channels answer from now on, and the push. */
async function pushPhoneAccess(app: ElectronApplication, snapshot: PhoneAccessState): Promise<void> {
  await app.evaluate((_electron, snapshot) => {
    (globalThis as typeof globalThis & { __phoneSnapshot: unknown }).__phoneSnapshot = snapshot;
  }, snapshot);
  await pushEvent(app, EVENT.phoneAccessChanged, snapshot);
}

async function phoneCalls(app: ElectronApplication): Promise<Calls> {
  return await app.evaluate(() => [...(globalThis as typeof globalThis & { __phoneCalls: Calls }).__phoneCalls]);
}

async function setContentSize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('/quick-ask/'))!
      .setContentSize(size.width, size.height);
  }, { width, height });
}

/** Type into the session's xterm, focusing its input directly: the placeholder covers it from the mouse. */
async function typeIntoTerminal(page: Page, text: string): Promise<void> {
  await page.locator('.terminal-container.visible .xterm-helper-textarea').focus();
  await page.keyboard.type(text);
}

test.describe('phone access', () => {
  test('a session a phone has shows the placeholder, takes no input, and comes back refitted on Use here', async ({ page, home, app }) => {
    /* Given */
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    await stubPhoneAccess(app, LISTENING);
    await expect.poll(() => claude.size()).not.toBeNull();
    const before = await terminalState(page, S.loginFix);

    /* When */
    await pushEvent(app, EVENT.terminalOwnerChanged, S.loginFix, PIXEL);

    /* Then */
    const placeholder = page.getByTestId('terminal-placeholder');
    await expect(placeholder.getByRole('heading', { name: 'Active on Pixel 9 Pro' })).toBeVisible();

    /* When */
    await typeIntoTerminal(page, 'from the mac');
    await setContentSize(app, 1100, 650);

    /* Then */
    // The xterm refits to the smaller window, but neither that nor the keys reach the session.
    await expect.poll(async () => (await terminalState(page, S.loginFix)).cols).toBeLessThan(before.cols);
    await page.waitForTimeout(300);
    expect(claude.input()).toBe('');
    expect(claude.size()).toEqual({ cols: before.cols, rows: before.rows });

    /* When */
    await placeholder.getByRole('button', { name: 'Use here' }).click();

    /* Then */
    await expect(placeholder).toHaveCount(0);
    expect(await phoneCalls(app)).toEqual([['useTerminalHere', S.loginFix]]);
    const after = await terminalState(page, S.loginFix);
    await expect.poll(() => claude.size()).toEqual({ cols: after.cols, rows: after.rows });

    /* When */
    await typeIntoTerminal(page, 'back');

    /* Then */
    await claude.waitForInput('back');
    expect(claude.input()).toBe('back');
  });

  test('the indicator, the settings section and the pairing confirmation follow main\'s snapshot', async ({ page, app }) => {
    /* Given */
    await stubPhoneAccess(app, LISTENING);
    const pairing = { invite: 'switchboard://pair?v=1&fp=AB&code=k7Qx&host=joris-mbp.local&port=48231', expiresAt: FIXTURE_NOW + 115_000 };

    /* When */
    await pushPhoneAccess(app, { ...LISTENING, pairing });

    /* Then */
    const indicator = sidebar(page).getByRole('button', { name: /Pixel 9 Pro connected/ });
    await expect(indicator).toHaveText('Pixel 9 Pro');

    /* When */
    await indicator.click();

    /* Then */
    const section = page.locator('#sv-phone-access');
    await expect(section).toBeVisible();
    await expect(section.getByText('Listening on Wi-Fi as joris-mbp.local · Pixel 9 Pro connected')).toBeVisible();
    await expect(section.getByRole('img', { name: 'Pairing code' })).toBeVisible();
    await expect(section.getByText('Expires in 1:55', { exact: true })).toBeVisible();
    await expect(section.getByText('Connected now')).toBeVisible();
    await expect(section.getByText('Last seen 4 days ago')).toBeVisible();

    /* When */
    await section.getByRole('button', { name: 'Stop pairing' }).click();
    await answerDialogs(page, false);
    await section.getByRole('button', { name: 'Revoke Pixel Tablet' }).click();
    await answerDialogs(page, true);
    await section.getByRole('button', { name: 'Reset…' }).click();

    /* Then */
    expect(await dialogsAsked(page)).toEqual(['Reset this Mac\'s identity? This makes a new key and un-pairs every phone.']);
    await expect.poll(() => phoneCalls(app)).toEqual([
      ['getPhoneAccess'],
      ['stopPhonePairing'],
      ['resetPhoneIdentity'],
    ]);

    /* When */
    await pushPhoneAccess(app, { ...LISTENING, confirm: { requestId: 'r1', deviceName: 'Pixel 8' } });

    /* Then */
    const confirm = page.getByRole('heading', { name: 'Pair “Pixel 8”?' }).locator('../..');
    await expect(confirm).toBeVisible();

    /* When */
    await confirm.getByRole('button', { name: 'Pair', exact: true }).click();

    /* Then */
    await expect(confirm).toHaveCount(0);
    await expect.poll(async () => (await phoneCalls(app)).at(-1)).toEqual(['confirmPhonePairing', 'r1', true]);
  });
});
