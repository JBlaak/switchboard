/**
 * A running session's real process: the fake `claude` launched in the
 * terminal, resumed with the question hook or started fresh from the picker,
 * and forked, which main detects from the new transcript (no unit test covers
 * that detection, so the journey stays here).
 *
 * What the app reads out of a session's output (busy and idle, notifications,
 * program status, the title) and the renderer's side of a fork are tested
 * against what main sends in the component suite (component/tests/terminal.spec.ts).
 * Typing and the exit are covered with the terminal host, in
 * terminal-host.spec.ts and component/tests/terminal-host.spec.ts.
 */
import {test, expect, forEachAppearance, screenTest} from '../support/test';
import {dialog, expectScreen, openSession, sessionRow, sidebar, terminalHeader} from '../support/app';
import {launchedKeys, waitForNewLaunch} from '../support/fake-cli';
import {sessionId} from '../support/fixture-home';
import {LABEL, S} from '../fixtures/standard';

test.describe('smoke', () => {
    test('resumes a session with the question hook and shows its header', async ({page, home}) => {
        /* When */
        const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
        const launch = await claude.launched();

        /* Then */
        expect(launch.resume).toBe(true);
        expect(launch.argv).toContain('--resume');
        expect(launch.settings?.hooks?.PreToolUse?.[0].matcher).toBe('AskUserQuestion');
        expect(launch.cwd).toBe(home.projectPath('Development/acme-api'));
        await expect(terminalHeader(page).getByText(LABEL.loginFix, {exact: true})).toBeVisible();
    });

    test('a fork re-keys the running session, keeping the same row, highlighted, and the same terminal', async ({
        page,
        home,
    }) => {
        /* Given */
        const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
        // Tag the live elements, so "the same row" means the same node and not
        // merely one that looks alike after a remove and re-add.
        await page.evaluate((id) => {
            const row = document.querySelector<HTMLElement>(`.session-item[data-session-id="${id}"]`)!;
            (row as HTMLElement & {e2eTag?: string}).e2eTag = 'row';
            const term = document.querySelector<HTMLElement>('.terminal-container.visible')!;
            (term as HTMLElement & {e2eTag?: string}).e2eTag = 'terminal';
        }, S.loginFix);
        const forkId = sessionId('login-fix-fork');

        /* When */
        await claude.fork(forkId, 'Forked: try a different redirect strategy');

        /* Then */
        await expect(page.locator(`.session-item[data-session-id="${forkId}"]`)).toBeVisible();
        const after = await page.evaluate((id) => {
            const row = document.querySelector<HTMLElement>(`.session-item[data-session-id="${id}"]`);
            const term = document.querySelector<HTMLElement>('.terminal-container.visible');
            return {
                rowTag: (row as (HTMLElement & {e2eTag?: string}) | null)?.e2eTag,
                active: row?.classList.contains('active'),
                terminalTag: (term as (HTMLElement & {e2eTag?: string}) | null)?.e2eTag,
            };
        }, forkId);
        expect(after).toMatchObject({rowTag: 'row', active: true, terminalTag: 'terminal'});
        // The fork's new turn may move the row to another section; it moves as itself.
        await expect(
            terminalHeader(page)
                .getByText('Forked: try a different redirect strategy')
                .or(page.locator('#terminal-header-name[title*="Forked: try a different redirect strategy"]')),
        ).toBeVisible();
    });

    test('a new session from the picker launches with a fresh id', async ({page, home}) => {
        /* Given */
        const before = launchedKeys(home);

        /* When */
        await page.getByRole('button', {name: 'Projects', exact: true}).click();
        await dialog(page, 'Projects').getByText('Development/web-dashboard', {exact: true}).click();

        /* Then */
        const claude = await waitForNewLaunch(home, 'claude', before);
        const launch = await claude.launched();
        expect(launch.resume).toBe(false);
        expect(launch.argv).toContain('--session-id');
        expect(launch.cwd).toBe(home.projectPath('Development/web-dashboard'));

        /* When */
        // The CLI's first transcript write is what makes the session a real row.
        await claude.userTurn('Make the export button work offline');

        /* Then */
        await expect(sessionRow(page, 'Make the export button work offline')).toBeVisible();
    });
});

forEachAppearance(() => {
    screenTest('terminal with header, running', async ({page, home}) => {
        /* Given */
        const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);

        /* When */
        await claude.busy('Reading the redirect handler');
        await claude.println(
            '',
            '\x1b[1m● Read\x1b[0m(src/auth/redirect.ts)',
            '  ⎿  Read 84 lines',
            '',
            '\x1b[32m●\x1b[0m The redirect loop comes from the session cookie being set',
            '  on the wrong path, so every request looks unauthenticated.',
        );

        /* Then */
        await expect(sidebar(page).getByText('Working', {exact: true})).toBeVisible();
        await expectScreen(page, 'terminal-running');
    });
});
