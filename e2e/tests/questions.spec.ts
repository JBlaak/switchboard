/**
 * The question panel: an AskUserQuestion posted to the session's hook, shown
 * over the terminal, and answered from Switchboard.
 *
 * These keep what only the running app can show: the hook round trip, a set
 * main holds across a reload, and how the panel looks. The panel's behaviour
 * against what main sends (the keys, clicks, motion, placement, peeking, the
 * farewell, the doze line, switching sessions, a withdrawn set) is in
 * component/tests/questions.spec.ts; what it decides on its own is unit tested
 * (test/answer-draft.test.ts, test/question-*.test.ts, test/answers-slice.test.ts).
 */
import {test, expect} from '../support/test';
import {openSession, sidebar} from '../support/app';
import {askQuestions} from '../support/questions';
import {LABEL, S} from '../fixtures/standard';
import type {Page} from '@playwright/test';
import type {FixtureHome} from '../support/fixture-home';
import type {AskedQuestion, PendingAsk} from '../support/questions';

const QUESTIONS: AskedQuestion[] = [
    {
        question: 'Where should the session cookie be scoped?',
        header: 'Cookie path',
        options: [
            {label: 'The whole site (Recommended)', description: 'Path=/ so every route sees the session.'},
            {label: 'Only /app', description: 'Keeps the cookie off the marketing pages.'},
        ],
    },
    {
        question: 'Which checks should run before I open the PR?',
        header: 'Checks',
        multiSelect: true,
        options: [
            {label: 'Unit tests', description: ''},
            {label: 'Type check', description: ''},
            {label: 'Lint', description: ''},
        ],
    },
];

type HookReply = {hookSpecificOutput: {updatedInput: {answers: Record<string, string>}}};

function questionPanel(page: Page) {
    return page.getByRole('region', {name: 'Questions from Claude'});
}

const heading = (page: Page, n: number) => questionPanel(page).getByRole('heading', {name: QUESTIONS[n].question});

/**
 * Open the newest session and ask it `questions`; answers once the first is on
 * screen.
 *
 * Without reduced motion unless `reducedMotion` is set. The harness launches
 * with reduced motion on, and under it the sheet cannot take the keyboard as
 * it comes up: the reduced-motion rule in _questions.scss narrows the sheet's
 * transition to `opacity, visibility`, which pairs `visibility` with the
 * 220ms opacity duration, so the sheet is still `visibility: hidden` when it
 * asks for focus. That is a styling bug of its own, not the panel's; the
 * keyboard runs the way most users see it.
 */
async function askedOnScreen(
    page: Page,
    home: FixtureHome,
    questions = QUESTIONS,
    {reducedMotion = false} = {},
): Promise<PendingAsk> {
    if (!reducedMotion) await page.emulateMedia({reducedMotion: 'no-preference'});
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    const asked = await askQuestions(home, S.loginFix, questions);
    await expect(questionPanel(page).getByRole('heading', {name: questions[0].question})).toBeVisible();
    return asked;
}

test.describe('smoke', () => {
    test('shows the questions and sends the answers back to the hook', async ({page, home}) => {
        /* Given */
        await openSession(page, home, LABEL.loginFix, S.loginFix);

        /* When */
        const asked = await askQuestions(home, S.loginFix, QUESTIONS);

        /* Then */
        const panel = questionPanel(page);
        await expect(panel.getByRole('heading', {name: QUESTIONS[0].question})).toBeVisible();
        await expect(sidebar(page).getByText('Asking 2 questions', {exact: true})).toBeVisible();

        /* When */
        await panel.getByRole('button', {name: /The whole site/}).click();
        await panel.getByRole('button', {name: /^Next/}).click();
        await expect(panel.getByRole('heading', {name: QUESTIONS[1].question})).toBeVisible();
        await panel.getByRole('button', {name: /Unit tests/}).click();
        await panel.getByRole('button', {name: /Lint/}).click();
        await panel.getByRole('button', {name: /Send answers/}).click();

        /* Then */
        const reply = (await asked.response) as HookReply;
        expect(reply.hookSpecificOutput.updatedInput.answers).toEqual({
            [QUESTIONS[0].question]: 'The whole site (Recommended)',
            [QUESTIONS[1].question]: 'Unit tests, Lint',
        });
        await expect(sidebar(page).getByText('Asking 2 questions', {exact: true})).toHaveCount(0);
    });
});

test.describe('data', () => {
    test('a set pending before the window loaded comes up after a reload', async ({page, home}) => {
        /* Given */
        await askedOnScreen(page, home);

        /* When */
        await page.reload();

        /* Then */
        await expect(heading(page, 0)).toBeVisible();
    });
});
