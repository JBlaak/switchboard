/**
 * Phone access's pushes into the window (#194): a session a phone started is
 * in the sidebar at once, and one it archived leaves the window.
 *
 * Main's side is played here: what it pushes is emitted, and archiving
 * answers as main's would (the session stopped, its row archived, so the
 * list's refetch leaves it out). The listener the switch in Settings starts
 * is in e2e/tests/phone-access-listener.spec.ts; what a phone does over it is
 * tested in node (test/phone-access-wiring.test.ts, test/phone-archive.test.ts).
 */
import {test, expect} from '../support/test';
import {openSession, runSessions} from '../support/running-session';
import {sessionRow, terminalHeader} from '../../e2e/support/app';
import {LABEL, P, S} from '../../e2e/fixtures/standard';
import {captured, fixtureProjectPath} from '../fixtures/captured';
import type {FakeApi} from '../support/fake-api';

/**
 * Archive the session as main does for a phone, or for a session that asked
 * to be archived once its turn ended: stopped, and its row archived, so the
 * list leaves it out from now on. The window is told separately.
 */
async function archiveInMain(api: FakeApi, sessionId: string): Promise<void> {
    const world = captured('standard');
    for (const project of world.projectsWithArchived) {
        for (const session of project.sessions) if (session.sessionId === sessionId) session.archived = 1;
    }
    for (const project of world.projects) {
        project.sessions = project.sessions.filter((session) => session.sessionId !== sessionId);
    }
    runSessions(api).delete(sessionId);
    api.handle('getProjects', (showArchived) => (showArchived ? world.projectsWithArchived : world.projects));
}

test('a session a phone started is in the sidebar before its transcript is', async ({page, api}) => {
    /* Given */
    await expect(sessionRow(page, 'New session')).toHaveCount(0);

    /* When */
    await api.emit('onSessionStarted', 'from-the-phone', fixtureProjectPath(P.acmeApi));

    /* Then */
    await expect(sessionRow(page, 'New session')).toBeVisible();
});

test('a session a phone archived leaves the window, as archiving it here would', async ({page, api}) => {
    /* Given */
    await openSession(page, api, LABEL.loginFix, S.loginFix);

    /* When */
    await archiveInMain(api, S.loginFix);
    await api.emit('onSessionArchived', S.loginFix);

    /* Then */
    await expect(terminalHeader(page)).toBeHidden();
    await expect(sessionRow(page, LABEL.loginFix)).toHaveCount(0);
});

test('a session archived from elsewhere leaves with confetti, as a click on its archive button would', async ({
    page,
    api,
}) => {
    /* Given */
    // The harness loads with reduced motion on, and under it there is no confetti.
    await page.emulateMedia({reducedMotion: 'no-preference'});
    await openSession(page, api, LABEL.loginFix, S.loginFix);

    /* When */
    await archiveInMain(api, S.loginFix);
    await api.emit('onSessionArchived', S.loginFix);

    /* Then */
    await expect(page.locator('.confetti .confetti__piece').first()).toBeAttached();
    await expect(sessionRow(page, LABEL.loginFix)).toHaveCount(0);
});
