/**
 * A running session, and what the app reads out of its output: busy and idle,
 * notifications, program status, the title, a fork.
 *
 * Main parses the OSC sequences and sends what they mean ahead of the raw
 * chunk (component/support/terminal-session.ts plays that part with main's own
 * parser); the title is xterm's, read from the chunk in the renderer. A fork is
 * what main sends when it spots the new transcript: `onSessionForked`, and the
 * fork's row in the next `getProjects`.
 *
 * Launching the real process (resuming with the question hook, a new session
 * from the picker) stays in e2e/tests/terminal.spec.ts, with the screenshot.
 */
import {test, expect, openSession} from '../support/terminal-session';
import {sessionRow, sidebar, sidebarFilter, terminalHeader} from '../../e2e/support/app';
import {FIXTURE_NOW, sessionId} from '../../e2e/support/fixture-home';
import {LABEL, S} from '../../e2e/fixtures/standard';
import {captured, fixtureProjectPath} from '../fixtures/captured';
import type {Page} from '@playwright/test';
import type {Project} from '../../src/domain/project/project';

/**
 * Flagging a session for attention marks its row in place; it moves to the
 * "Blocked" section on the next redraw, which toggling a filter forces.
 */
async function redrawSidebar(page: Page): Promise<void> {
    await sidebarFilter(page, 'pinned').click();
    await sidebarFilter(page, 'pinned').click();
}

/** The session's name in the bar; its tooltip is what the process last called itself. */
const headerName = (page: Page) => page.locator('#terminal-header-name');

/**
 * The standard projects once `forkId`'s transcript has been indexed: a new
 * session in acme-api, named by its first prompt, as main lists it.
 */
function withFork(projects: Project[], forkId: string, prompt: string): Project[] {
    const acmeApi = fixtureProjectPath('Development/acme-api');
    const now = new Date(FIXTURE_NOW).toISOString();
    return projects.map((project) =>
        project.projectPath !== acmeApi
            ? project
            : {
                  ...project,
                  sessions: [
                      {
                          sessionId: forkId,
                          summary: prompt,
                          firstPrompt: prompt,
                          created: now,
                          modified: now,
                          messageCount: 1,
                          projectPath: acmeApi,
                          slug: null,
                          aiTitle: null,
                          pullRequests: [],
                          name: null,
                          starred: 0,
                          archived: 0,
                          snoozedUntil: null,
                      },
                      ...project.sessions,
                  ],
              },
    );
}

test.describe('smoke', () => {
    test('OSC 0 titles set the header and drive working/ready, and a notification replaces the title', async ({
        page,
        sessions,
    }) => {
        /* Given */
        const claude = await openSession(page, sessions, LABEL.loginFix, S.loginFix);

        /* When */
        await claude.busy('Reading the redirect handler');

        /* Then */
        await expect(sidebar(page).getByText('Working', {exact: true})).toBeVisible();
        // The process title is the session name's tooltip (#343).
        await expect(headerName(page)).toHaveAttribute('title', '⠋ Reading the redirect handler');

        /* When */
        await claude.idle('Claude Code');

        /* Then */
        await expect(sidebar(page).getByText('Your turn', {exact: true})).toBeVisible();
        await expect(headerName(page)).toHaveAttribute('title', '✳ Claude Code');

        /* When */
        await claude.notify('Claude needs your permission to use Bash');

        /* Then */
        await expect(headerName(page)).toHaveAttribute('title', 'Claude needs your permission to use Bash');
    });

    test('OSC 7501 program status overrides titles, and it or an OSC 9 notification flags a session off screen', async ({
        page,
        sessions,
    }) => {
        /* Given */
        const claude = await openSession(page, sessions, LABEL.loginFix, S.loginFix);

        /* When */
        await claude.status({state: 'working'});

        /* Then */
        await expect(sidebar(page).getByText('Working', {exact: true})).toBeVisible();

        /* When */
        // Once 7501 is spoken, an idle title no longer ends the turn.
        await claude.idle();

        /* Then */
        await expect(sidebar(page).getByText('Working', {exact: true})).toBeVisible();

        /* When */
        // A session on screen is never flagged (the user is looking at it).
        await openSession(page, sessions, LABEL.chartsDarkMode, S.chartsDarkMode);
        await claude.status({state: 'blocked', kind: 'permission', msg: 'Allow Bash(npm test)?'});
        await redrawSidebar(page);

        /* Then */
        await expect(sidebar(page).getByText('Blocked', {exact: true})).toBeVisible();

        /* When */
        // Looking at it settles the flag; a notification raises it again.
        await sessionRow(page, LABEL.loginFix).click();
        await claude.status({state: 'working'});
        await sessionRow(page, LABEL.chartsDarkMode).click();
        await redrawSidebar(page);

        /* Then */
        await expect(sidebar(page).getByText('Blocked', {exact: true})).toHaveCount(0);

        /* When */
        await claude.notify('Claude needs your permission to use Bash');
        await claude.notify777('Claude Code', 'Claude needs your permission to use Bash');
        await redrawSidebar(page);

        /* Then */
        await expect(sidebar(page).getByText('Blocked', {exact: true})).toBeVisible();
    });

    test('a fork re-keys the running session, keeping the same row, highlighted, and the same terminal', async ({
        page,
        api,
        sessions,
    }) => {
        /* Given */
        await openSession(page, sessions, LABEL.loginFix, S.loginFix);
        // Tag the live elements, so "the same row" means the same node and not
        // merely one that looks alike after a remove and re-add.
        await page.evaluate((id) => {
            const row = document.querySelector<HTMLElement>(`.session-item[data-session-id="${id}"]`)!;
            (row as HTMLElement & {e2eTag?: string}).e2eTag = 'row';
            const term = document.querySelector<HTMLElement>('.terminal-container.visible')!;
            (term as HTMLElement & {e2eTag?: string}).e2eTag = 'terminal';
        }, S.loginFix);
        const forkId = sessionId('login-fix-fork');
        const prompt = 'Forked: try a different redirect strategy';
        // The fork's transcript is written, and indexed: main lists it from now on.
        const {projects, projectsWithArchived} = captured('standard');
        api.handle('getProjects', (showArchived) =>
            withFork(showArchived ? projectsWithArchived : projects, forkId, prompt),
        );

        /* When */
        // Main matches the new transcript to the running session.
        await sessions.fork(S.loginFix, forkId);

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
                .getByText(prompt)
                .or(page.locator(`#terminal-header-name[title*="${prompt}"]`)),
        ).toBeVisible();
    });
});
