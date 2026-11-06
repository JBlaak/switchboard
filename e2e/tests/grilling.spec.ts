/**
 * The grilling card: a round of questions Claude writes out at the end of a
 * turn, read through the Stop hook, answered on the card and typed into the
 * session.
 *
 * What the card decides on its own is unit tested: parsing the round
 * (test/grill-round.test.ts, test/grill-choices.test.ts), carrying answers
 * across revisions (test/grill-answering.test.ts), the service's lifecycle,
 * asks and queued sends (test/grill-service.test.ts), and the card's keys,
 * banner and labels (test/grill-*.test.ts). These tests keep what only the
 * running app shows: the hook round-trip, the keyboard on the card, and what
 * reaches the session's terminal.
 */
import {test, expect} from '../support/test';
import {expectScreen, openSession, sidebar} from '../support/app';
import {endTurn, submitPrompt} from '../support/questions';
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

/** The same round once Claude has revised its second question. */
const REVISED = ROUND.replace('➡️ (a) SQLite.', '➡️ (b) Redis: the load balancer needs shared sessions.');

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

    test('a prompt typed in the terminal takes the round away', async ({page, home}) => {
        /* Given */
        await openSession(page, home, LABEL.loginFix, S.loginFix);
        await endTurn(home, S.loginFix, ROUND);
        await expect(title(page, 'Keep the old login route?')).toBeVisible();

        /* When */
        await submitPrompt(home, S.loginFix, 'Q1: yes');

        /* Then */
        await expect(card(page)).toHaveCount(0);
        await expect(sidebar(page).getByText('Asking 2 questions', {exact: true})).toHaveCount(0);
    });

    test('a revision keeps the unchanged answer and sets the changed one aside', async ({page, home}) => {
        /* Given */
        await openSession(page, home, LABEL.loginFix, S.loginFix);
        await endTurn(home, S.loginFix, ROUND);
        await expect(title(page, 'Keep the old login route?')).toBeVisible();
        await page.keyboard.press('y');
        await page.keyboard.press('y');
        await expect(card(page).getByRole('heading', {name: 'Review your answers'})).toBeVisible();

        /* When */
        await endTurn(home, S.loginFix, REVISED);

        /* Then */
        await expect(card(page).getByText('Claude revised the round: 1 changed.')).toBeVisible();
        await expect(card(page).getByText('Changed, earlier answer set aside')).toBeVisible();
        await expect(card(page).getByText('Q1: yes', {exact: true})).toBeVisible();
    });

    test('asking about a question keeps the round open and shows the answer on it', async ({page, home}) => {
        /* Given */
        await openSession(page, home, LABEL.loginFix, S.loginFix);
        await endTurn(home, S.loginFix, ROUND);
        await expect(title(page, 'Keep the old login route?')).toBeVisible();

        /* When */
        await page.keyboard.press('?');
        await page.keyboard.type('Which two clients?');
        await page.keyboard.press('Enter');

        /* Then */
        const ask = 'Before I answer the round, about Q1: Which two clients?';
        await fakeClaude(home, S.loginFix).waitForInput(ask);

        /* When */
        await submitPrompt(home, S.loginFix, ask);
        await endTurn(home, S.loginFix, 'The iOS app and the partner dashboard.');

        /* Then */
        await expect(card(page).getByText('The iOS app and the partner dashboard.')).toBeVisible();
        await expect(title(page, 'Keep the old login route?')).toBeVisible();
        await expect(sidebar(page).getByText('Asking 2 questions', {exact: true})).toBeVisible();
    });

    test('grilling card', async ({page, home}) => {
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
