/**
 * The grilling card: a round of questions Claude writes out at the end of a
 * turn, read through the Stop hook, answered on the card and typed into the
 * session.
 *
 * These keep what only the running app shows: the hook round trip, the
 * keyboard on the card, what reaches the session's terminal, and how the card
 * looks. The card against main's GrillService (a prompt taking the round
 * away, a revision, an ask) is in component/tests/grilling.spec.ts; what it
 * decides on its own is unit tested (test/grill-*.test.ts).
 */
import {test, expect, screenTest} from '../support/test';
import {expectScreen, openSession, sidebar} from '../support/app';
import {endTurn} from '../support/questions';
import {fakeClaude} from '../support/fake-cli';
import {LABEL, S} from '../fixtures/standard';
import type {Page} from '@playwright/test';

/** A grilling round, as the grilling skill ends a turn with it. */
const ROUND = [
    'Settled: the cookie stays httpOnly.',
    '',
    '❓ **Q1** - **Keep the old login route?**: Two clients still call it.',
    '',
    '➡️ Keep it for one more release.',
    '',
    '---',
    '',
    '❓ **Q2** - **Where do sessions live?**: Pick a store: (a) SQLite, one file; (b) Redis, shared but needs a server.',
    '',
    '➡️ (a) SQLite.',
].join('\n');

function card(page: Page) {
    return page.getByRole('region', {name: 'Grilling round from Claude'});
}

function title(page: Page, name: string) {
    return card(page).getByRole('heading', {name});
}

test.describe('grilling', () => {
    test('a round is answered on the card and typed into the session', async ({page, home}) => {
        /* Given */
        await openSession(page, home, LABEL.loginFix, S.loginFix);

        /* When */
        await endTurn(home, S.loginFix, ROUND);

        /* Then */
        await expect(title(page, 'Keep the old login route?')).toBeVisible();
        await expect(card(page).getByText('Two clients still call it.')).toBeVisible();
        await expect(sidebar(page).getByText('Asking 2 questions', {exact: true})).toBeVisible();

        /* When */
        await page.keyboard.press('y');
        await expect(title(page, 'Where do sessions live?')).toBeVisible();
        await page.keyboard.press('2');
        await page.keyboard.press('Meta+Enter');

        /* Then */
        await fakeClaude(home, S.loginFix).waitForInput('Q1: yes\nQ2: (b) Redis, shared but needs a server');
        await expect(card(page)).toHaveCount(0);
        await expect(sidebar(page).getByText('Asking 2 questions', {exact: true})).toHaveCount(0);
    });

    screenTest('grilling card', async ({page, home}) => {
        /* Given */
        await openSession(page, home, LABEL.loginFix, S.loginFix);
        await endTurn(home, S.loginFix, ROUND);
        await expect(title(page, 'Keep the old login route?')).toBeVisible();

        /* When */
        await page.keyboard.press('y');

        /* Then */
        await expect(title(page, 'Where do sessions live?')).toBeVisible();
        await expectScreen(page, 'grilling-card');
    });
});
