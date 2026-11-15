/**
 * The Session work page (#74) against the real service: the fixture home has
 * no git repositories, so the service finds none and leaves every meta line
 * as text, and Cmd+G opens nothing.
 *
 * Opening, closing, the keys, what the page hands to main and the diff are
 * component tests (component/tests/session-work.spec.ts), against the stub's
 * answers (fixtures/session-work.ts).
 */
import {test, expect} from '../support/test';
import {openSession, terminalHeader} from '../support/app';
import {sessionItem} from '../support/session-list';
import {LABEL, S} from '../fixtures/standard';

test.describe('against the real service', () => {
    test('a session outside a git repository has a plain meta line, and Cmd+G does nothing for it', async ({
        page,
        home,
    }) => {
        /* Given */
        const row = sessionItem(page, S.loginFix);
        await expect(row.locator('[title="Not a git repository"]')).toHaveCount(1);
        await expect(row.getByRole('button', {name: /^Open session work/})).toHaveCount(0);
        await openSession(page, home, LABEL.loginFix, S.loginFix);

        /* When */
        await page.keyboard.press('Meta+g');
        // Cmd+G asks main again before giving up; wait for that round trip.
        await page.evaluate((id) => window.api.canOpenSessionWork(id), S.loginFix);

        /* Then */
        await expect(page.getByRole('region', {name: /^Session work for /})).toHaveCount(0);
        await expect(terminalHeader(page)).toBeVisible();
    });
});
