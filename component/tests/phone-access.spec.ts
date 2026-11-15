/**
 * Phone access on the Mac (#194): the terminal placeholder for a session a
 * phone has, and the settings, indicator and pairing confirmation drawn from
 * main's snapshot.
 *
 * Main's Phone access channels answer with the snapshot last pushed, and its
 * pushes are emitted directly, so these check what the renderer draws and
 * asks for. The rules behind the drawing — the slice, the copy, what each
 * control calls — are unit tested (test/phone-access-slice.test.ts,
 * test/phone-access-actions.test.ts). The listener itself is in
 * e2e/tests/phone-access-listener.spec.ts.
 */
import {test, expect} from '../support/test';
import {openSession, typedInto, waitForInput} from '../support/running-session';
import {sidebar} from '../../e2e/support/app';
import {answerDialogs, dialogsAsked} from '../../e2e/support/native-dialogs';
import {terminalState} from '../../e2e/support/terminal';
import {LABEL, S} from '../../e2e/fixtures/standard';
import {FIXTURE_NOW} from '../../e2e/support/fixture-home';
import {PHONE_ACCESS_OFF} from '../../src/domain/phone/state';
import type {Page} from '@playwright/test';
import type {PhoneAccessState} from '../../src/domain/phone/state';
import type {CallName, FakeApi} from '../support/fake-api';

const PIXEL = {kind: 'device', deviceId: 'd1', name: 'Pixel 9 Pro'} as const;

const LISTENING: PhoneAccessState = {
    ...PHONE_ACCESS_OFF,
    enabled: true,
    listening: true,
    host: 'joris-mbp.local',
    port: 48231,
    devices: [
        {id: 'd1', name: 'Pixel 9 Pro', pairedAt: FIXTURE_NOW - 3_600_000, lastSeenAt: FIXTURE_NOW, connected: true},
        {
            id: 'd2',
            name: 'Pixel Tablet',
            pairedAt: FIXTURE_NOW - 20 * 86_400_000,
            lastSeenAt: FIXTURE_NOW - 4 * 86_400_000,
            connected: false,
        },
    ],
};

const PHONE_METHODS = [
    'getPhoneAccess',
    'setPhoneAccessEnabled',
    'startPhonePairing',
    'stopPhonePairing',
    'confirmPhonePairing',
    'revokePhoneDevice',
    'resetPhoneIdentity',
    'useTerminalHere',
] as const satisfies readonly CallName[];

/** Main's Phone access, as far as the window sees it: the snapshot its channels answer and push. */
class PhoneAccess {
    private snapshot: PhoneAccessState;
    private readonly since: number;

    /**
     * Answer main's Phone access channels from now on, each with the snapshot
     * last pushed (Use here with `{ ok: true }`), as main would answer it.
     */
    constructor(
        private readonly api: FakeApi,
        snapshot: PhoneAccessState,
    ) {
        this.snapshot = snapshot;
        this.since = api.calls.length;
        for (const method of PHONE_METHODS) {
            api.handle(method, (() => (method === 'useTerminalHere' ? {ok: true} : this.snapshot)) as never);
        }
    }

    /** Main's snapshot changed: what its channels answer from now on, and the push. */
    public async push(snapshot: PhoneAccessState): Promise<void> {
        this.snapshot = snapshot;
        await this.api.emit('onPhoneAccessChanged', snapshot);
    }

    /** Every call on its channels since it was set up, as `[method, ...args]`. */
    public calls(): [string, ...unknown[]][] {
        return this.api.calls
            .slice(this.since)
            .filter((call) => (PHONE_METHODS as readonly string[]).includes(call.name))
            .map((call) => [call.name, ...call.args]);
    }
}

/** The size main last gave the session's pty, or null before the first resize. */
function ptySize(api: FakeApi): {cols: number; rows: number} | null {
    const last = api
        .callsTo('resizeTerminal')
        .filter(([id]) => id === S.loginFix)
        .at(-1);
    return last ? {cols: last[1], rows: last[2]} : null;
}

/**
 * Wait until the session's xterm has been fitted to the window and the pty has
 * that size too. Until the first fit both sit on xterm's own 80 × 24.
 */
async function waitForFittedSession(page: Page, api: FakeApi): Promise<void> {
    await expect
        .poll(async () => {
            const {cols, rows} = await terminalState(page, S.loginFix);
            const pty = ptySize(api);
            const fitted = cols !== 80 || rows !== 24;
            return fitted && pty?.cols === cols && pty?.rows === rows;
        })
        .toBe(true);
}

/** Type into the session's xterm, focusing its input directly: the placeholder covers it from the mouse. */
async function typeIntoTerminal(page: Page, text: string): Promise<void> {
    await page.locator('.terminal-container.visible .xterm-helper-textarea').focus();
    await page.keyboard.type(text);
}

test.use({
    answers: {},
});

test.describe('phone access', () => {
    test('a session a phone has shows the placeholder, takes no input, and comes back refitted on Use here', async ({
        page,
        api,
    }) => {
        /* Given */
        await openSession(page, api, LABEL.loginFix, S.loginFix);
        const phone = new PhoneAccess(api, LISTENING);
        await waitForFittedSession(page, api);
        const before = await terminalState(page, S.loginFix);

        /* When */
        await api.emit('onTerminalOwnerChanged', S.loginFix, PIXEL);

        /* Then */
        const placeholder = page.getByTestId('terminal-placeholder');
        await expect(placeholder.getByRole('heading', {name: 'Active on Pixel 9 Pro'})).toBeVisible();

        /* When */
        await typeIntoTerminal(page, 'from the mac');
        await page.setViewportSize({width: 1100, height: 650});

        /* Then */
        // The xterm refits to the smaller window, but neither that nor the keys reach the session.
        await expect.poll(async () => (await terminalState(page, S.loginFix)).cols).toBeLessThan(before.cols);
        await page.waitForTimeout(300);
        expect(typedInto(api, S.loginFix)).toBe('');
        expect(ptySize(api)).toEqual({cols: before.cols, rows: before.rows});

        /* When */
        await placeholder.getByRole('button', {name: 'Use here'}).click();

        /* Then */
        await expect(placeholder).toHaveCount(0);
        expect(phone.calls()).toEqual([['useTerminalHere', S.loginFix]]);
        const after = await terminalState(page, S.loginFix);
        await expect.poll(() => ptySize(api)).toEqual({cols: after.cols, rows: after.rows});

        /* When */
        await typeIntoTerminal(page, 'back');

        /* Then */
        await waitForInput(api, S.loginFix, 'back');
        expect(typedInto(api, S.loginFix)).toBe('back');
    });

    test("the indicator, the settings section and the pairing confirmation follow main's snapshot", async ({
        page,
        api,
    }) => {
        /* Given */
        const phone = new PhoneAccess(api, LISTENING);
        const pairing = {
            invite: 'switchboard://pair?v=1&fp=AB&code=k7Qx&host=joris-mbp.local&port=48231',
            expiresAt: FIXTURE_NOW + 115_000,
        };

        /* When */
        await phone.push({...LISTENING, pairing});

        /* Then */
        const indicator = sidebar(page).getByRole('button', {name: /Pixel 9 Pro connected/});
        await expect(indicator).toHaveText('Pixel 9 Pro');

        /* When */
        await indicator.click();

        /* Then */
        const section = page.locator('#sv-phone-access');
        await expect(section).toBeVisible();
        await expect(section.getByText('Listening on Wi-Fi as joris-mbp.local · Pixel 9 Pro connected')).toBeVisible();
        await expect(section.getByRole('img', {name: 'Pairing code'})).toBeVisible();
        await expect(section.getByText('Expires in 1:55', {exact: true})).toBeVisible();
        await expect(section.getByText('Connected now')).toBeVisible();
        await expect(section.getByText('Last seen 4 days ago')).toBeVisible();

        /* When */
        await section.getByRole('button', {name: 'Stop pairing'}).click();
        await answerDialogs(page, false);
        await section.getByRole('button', {name: 'Revoke Pixel Tablet'}).click();
        await answerDialogs(page, true);
        await section.getByRole('button', {name: 'Reset…'}).click();

        /* Then */
        expect(await dialogsAsked(page)).toEqual([
            "Reset this Mac's identity? This makes a new key and un-pairs every phone.",
        ]);
        await expect
            .poll(() => phone.calls())
            .toEqual([['getPhoneAccess'], ['stopPhonePairing'], ['resetPhoneIdentity']]);

        /* When */
        await phone.push({...LISTENING, confirm: {requestId: 'r1', deviceName: 'Pixel 8'}});

        /* Then */
        const confirm = page.getByRole('heading', {name: 'Pair “Pixel 8”?'}).locator('../..');
        await expect(confirm).toBeVisible();

        /* When */
        await confirm.getByRole('button', {name: 'Pair', exact: true}).click();

        /* Then */
        await expect(confirm).toHaveCount(0);
        await expect.poll(() => phone.calls().at(-1)).toEqual(['confirmPhonePairing', 'r1', true]);
    });
});
