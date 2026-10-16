/**
 * The question panel: an AskUserQuestion posted to the session's hook, shown
 * over the terminal, and answered from Switchboard.
 */
import { test, expect, forEachAppearance } from '../support/test';
import { expectScreen, openSession, sidebar } from '../support/app';
import { askQuestions } from '../support/questions';
import { LABEL, S } from '../fixtures/standard';
import type { AskedQuestion } from '../support/questions';

const QUESTIONS: AskedQuestion[] = [
  {
    question: 'Where should the session cookie be scoped?',
    header: 'Cookie path',
    options: [
      { label: 'The whole site (Recommended)', description: 'Path=/ so every route sees the session.' },
      { label: 'Only /app', description: 'Keeps the cookie off the marketing pages.' },
    ],
  },
  {
    question: 'Which checks should run before I open the PR?',
    header: 'Checks',
    multiSelect: true,
    options: [
      { label: 'Unit tests', description: '' },
      { label: 'Type check', description: '' },
      { label: 'Lint', description: '' },
    ],
  },
];

function questionPanel(page: import('@playwright/test').Page) {
  return page.getByRole('region', { name: 'Questions from Claude' });
}

test.describe('smoke', () => {
  test('shows the questions and sends the answers back to the hook', async ({ page, home }) => {
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    const asked = await askQuestions(home, S.loginFix, QUESTIONS);

    const panel = questionPanel(page);
    await expect(panel.getByRole('heading', { name: QUESTIONS[0].question })).toBeVisible();
    await expect(sidebar(page).getByText('Asking 2 questions', { exact: true })).toBeVisible();

    await panel.getByRole('button', { name: /The whole site/ }).click();
    await panel.getByRole('button', { name: /^Next/ }).click();
    await expect(panel.getByRole('heading', { name: QUESTIONS[1].question })).toBeVisible();
    await panel.getByRole('button', { name: /Unit tests/ }).click();
    await panel.getByRole('button', { name: /Lint/ }).click();
    await panel.getByRole('button', { name: /Send answers/ }).click();

    const reply = await asked.response as { hookSpecificOutput: { updatedInput: { answers: Record<string, string> } } };
    expect(reply.hookSpecificOutput.updatedInput.answers).toEqual({
      [QUESTIONS[0].question]: 'The whole site (Recommended)',
      [QUESTIONS[1].question]: 'Unit tests, Lint',
    });
    await expect(sidebar(page).getByText('Asking 2 questions', { exact: true })).toHaveCount(0);
  });

  test('withdraws the panel when the hook request goes away', async ({ page, home }) => {
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    const asked = await askQuestions(home, S.loginFix, QUESTIONS.slice(0, 1));
    await expect(questionPanel(page).getByRole('heading', { name: QUESTIONS[0].question })).toBeVisible();
    asked.abandon();
    await expect(sidebar(page).getByText('Asking 1 question', { exact: true })).toHaveCount(0);
  });
});

forEachAppearance(() => {
  test('question panel', async ({ page, home }) => {
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await askQuestions(home, S.loginFix, QUESTIONS);
    await expect(questionPanel(page).getByRole('heading', { name: QUESTIONS[0].question })).toBeVisible();
    await expectScreen(page, 'question-panel');
  });
});
