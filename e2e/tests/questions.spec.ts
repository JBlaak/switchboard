/**
 * The question panel: an AskUserQuestion posted to the session's hook, shown
 * over the terminal, and answered from Switchboard.
 *
 * What the panel decides on its own is unit tested: the draft rules
 * (test/answer-draft.test.ts), Patch's lines (test/question-beats.test.ts,
 * test/answers-slice.test.ts), the copy (test/question-copy.test.ts) and what
 * each key means (test/question-panel-keys.test.ts). These tests keep what
 * only the running app can show: the hook round-trip, where the keyboard
 * goes, the motion, and how it looks.
 */
import { test, expect, forEachAppearance } from '../support/test';
import { expectScreen, openSession, sessionRow, sidebar, terminalHeader } from '../support/app';
import {
  askQuestions, endTurn, focusIsIn, option, pushQuestions, questionSheet, recordAnimations, recordedAnimations,
  submitPrompt,
} from '../support/questions';
import { fakeClaude } from '../support/fake-cli';
import { LABEL, S } from '../fixtures/standard';
import type { Page } from '@playwright/test';
import type { FixtureHome } from '../support/fixture-home';
import type { AskedQuestion, PendingAsk } from '../support/questions';

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

/** A grilling round, as the `grilling` skill ends a turn with it. */
const ROUND = [
  'Settled: the cookie stays httpOnly.',
  '',
  '❓ **Q1** - **Keep the old login route?**: Two clients still call it.',
  '',
  '➡️ Keep it for one more release.',
  '',
  '---',
  '',
  '❓ **Q2** - **Where do sessions live?**: Pick a store.',
  '',
  '- **A)** SQLite — one file, no server',
  '- **B)** Redis — shared, needs a server',
  '',
  '➡️ A, SQLite.',
].join('\n');

type HookReply = { hookSpecificOutput: { updatedInput: { answers: Record<string, string> } } };

function questionPanel(page: import('@playwright/test').Page) {
  return page.getByRole('region', { name: 'Questions from Claude' });
}

const heading = (page: Page, n: number) => questionPanel(page).getByRole('heading', { name: QUESTIONS[n].question });
const tab = (page: Page, name: string) =>
  questionPanel(page).getByRole('navigation', { name: 'Questions' }).getByRole('button', { name });
const primary = (page: Page) => questionPanel(page).getByRole('button', { name: /^(Next|Send answers)/ });
const otherField = (page: Page) => questionPanel(page).getByRole('textbox', { name: 'Other answer' });
const patchSays = (page: Page) => questionPanel(page).getByRole('status');
const pokePatch = (page: Page) => questionPanel(page).getByRole('button', { name: 'Poke Patch' });
const toTerminalButton = (page: Page) => terminalHeader(page).getByRole('button', { name: /Answer in terminal/ });
const waitingPill = (page: Page) =>
  terminalHeader(page).getByRole('button', { name: /(waiting|Ready to send) · Show$/ });

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
 * keyboard tests run the way most users see it. The screenshots keep reduced
 * motion, and so reach their states by clicking.
 */
async function askedOnScreen(
  page: Page, home: FixtureHome, questions = QUESTIONS, { reducedMotion = false } = {},
): Promise<PendingAsk> {
  if (!reducedMotion) await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openSession(page, home, LABEL.loginFix, S.loginFix);
  const asked = await askQuestions(home, S.loginFix, questions);
  await expect(questionPanel(page).getByRole('heading', { name: questions[0].question })).toBeVisible();
  return asked;
}

/** Fire keydowns at the element that has focus, all in one task, so nothing runs between them. */
async function keysAtOnce(page: Page, keys: string[]): Promise<void> {
  await page.evaluate((keys) => {
    const target = document.activeElement ?? document.body;
    for (const key of keys) target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  }, keys);
}

test.describe('smoke', () => {
  test('shows the questions and sends the answers back to the hook', async ({ page, home }) => {
    /* Given */
    await openSession(page, home, LABEL.loginFix, S.loginFix);

    /* When */
    const asked = await askQuestions(home, S.loginFix, QUESTIONS);

    /* Then */
    const panel = questionPanel(page);
    await expect(panel.getByRole('heading', { name: QUESTIONS[0].question })).toBeVisible();
    await expect(sidebar(page).getByText('Asking 2 questions', { exact: true })).toBeVisible();

    /* When */
    await panel.getByRole('button', { name: /The whole site/ }).click();
    await panel.getByRole('button', { name: /^Next/ }).click();
    await expect(panel.getByRole('heading', { name: QUESTIONS[1].question })).toBeVisible();
    await panel.getByRole('button', { name: /Unit tests/ }).click();
    await panel.getByRole('button', { name: /Lint/ }).click();
    await panel.getByRole('button', { name: /Send answers/ }).click();

    /* Then */
    const reply = await asked.response as HookReply;
    expect(reply.hookSpecificOutput.updatedInput.answers).toEqual({
      [QUESTIONS[0].question]: 'The whole site (Recommended)',
      [QUESTIONS[1].question]: 'Unit tests, Lint',
    });
    await expect(sidebar(page).getByText('Asking 2 questions', { exact: true })).toHaveCount(0);
  });

  test('withdraws the panel when the hook request goes away, and gives the keyboard back', async ({ page, home }) => {
    /* When */
    const asked = await askedOnScreen(page, home, QUESTIONS.slice(0, 1));

    /* Then */
    expect(await focusIsIn(page)).toBe('panel');
    await expect(sidebar(page).getByText('Asking 1 question', { exact: true })).toBeVisible();

    /* When */
    asked.abandon();

    /* Then */
    await expect(questionPanel(page)).toHaveCount(0);
    await expect(sidebar(page).getByText('Asking 1 question', { exact: true })).toHaveCount(0);
    await expect(toTerminalButton(page)).toHaveCount(0);
    await expect(waitingPill(page)).toHaveCount(0);
    await expect.poll(() => focusIsIn(page)).toBe('terminal');
  });
});

forEachAppearance(() => {
  test('question panel', async ({ page, home }) => {
    /* Given */
    await openSession(page, home, LABEL.loginFix, S.loginFix);

    /* When */
    await askQuestions(home, S.loginFix, QUESTIONS);

    /* Then */
    await expect(questionPanel(page).getByRole('heading', { name: QUESTIONS[0].question })).toBeVisible();
    await expectScreen(page, 'question-panel');
  });

  test('question panel, grilling round', async ({ page, home }) => {
    /* Given */
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await endTurn(home, S.loginFix, ROUND);
    await expect(questionPanel(page).getByRole('heading', { name: 'Keep the old login route?' })).toBeVisible();

    /* When */
    await option(page, /Keep it for one more release/).click();
    await primary(page).click();

    /* Then */
    await expect(questionPanel(page).getByRole('heading', { name: 'Where do sessions live?' })).toBeVisible();
    await expectScreen(page, 'question-panel-grill');
  });

  test('question panel, peeking at the terminal', async ({ page, home }) => {
    /* Given */
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await askQuestions(home, S.loginFix, QUESTIONS);
    await expect(questionPanel(page).getByRole('heading', { name: QUESTIONS[0].question })).toBeVisible();

    /* When */
    await questionPanel(page).getByRole('button', { name: /Peek at terminal/ }).click();

    /* Then */
    await expect(page.getByRole('button', { name: /Back to questions/ })).toBeVisible();
    await expectScreen(page, 'question-peek');
  });
});

test.describe('data', () => {
  test('a set pending before the window loaded comes up after a reload', async ({ page, home }) => {
    /* Given */
    await askedOnScreen(page, home);

    /* When */
    await page.reload();

    /* Then */
    await expect(heading(page, 0)).toBeVisible();
  });
});

// Chromium left a question block it had animated before on the hidden
// sheet's inherited style, so a later showing came up blank and took no
// clicks (#120). A click that lands proves the block is drawn and hit.
test.describe('showing again', () => {
  const sheetGone = (page: Page) =>
    expect.poll(() => questionSheet(page).evaluate(el => getComputedStyle(el).visibility)).toBe('hidden');

  test('a later set comes up whole and takes clicks', async ({ page, home }) => {
    /* Given */
    const first = await askedOnScreen(page, home);
    await option(page, /The whole site/).click();
    await primary(page).click();
    await option(page, /Unit tests/).click();
    await primary(page).click();
    await first.response;
    await sheetGone(page);

    /* When */
    const second = await askQuestions(home, S.loginFix, QUESTIONS);
    await option(page, /Only \/app/).click({ timeout: 3000 });
    await primary(page).click();
    await option(page, /Lint/).click({ timeout: 3000 });
    await primary(page).click();

    /* Then */
    const reply = await second.response as HookReply;
    expect(reply.hookSpecificOutput.updatedInput.answers).toEqual({
      [QUESTIONS[0].question]: 'Only /app',
      [QUESTIONS[1].question]: 'Lint',
    });
  });

  test('a set come back to from the terminal takes clicks', async ({ page, home }) => {
    /* Given */
    await askedOnScreen(page, home);
    await option(page, /The whole site/).click();
    await primary(page).click();
    await expect(heading(page, 1)).toBeVisible();
    await page.keyboard.press('Escape');
    await sheetGone(page);

    /* When */
    await waitingPill(page).click();
    await option(page, /Lint/).click({ timeout: 3000 });

    /* Then */
    await expect(tab(page, 'Checks')).toHaveClass(/is-done/);
  });
});

test.describe('placement', () => {
  test('sits over the terminal of the session asking, following it on screen without transitions', async ({ page, home }) => {
    /* Given */
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await openSession(page, home, LABEL.worktreeTry, S.worktreeTry);

    /* When */
    await askQuestions(home, S.loginFix, QUESTIONS);

    /* Then */
    await expect(sidebar(page).getByText('Asking 2 questions', { exact: true })).toBeVisible();
    // Asked behind the session on screen: nothing comes up over it.
    await expect(questionPanel(page)).toHaveCount(0);
    await expect(page.locator('.terminal-container.qp-under')).toHaveCount(0);

    /* When */
    await page.evaluate(() => {
      const terminals = document.getElementById('terminals')!;
      const w = window as unknown as { __instant: number };
      w.__instant = 0;
      new MutationObserver(() => { if (terminals.classList.contains('qp-instant')) w.__instant++; })
        .observe(terminals, { attributes: true, attributeFilter: ['class'] });
    });
    await sessionRow(page, LABEL.loginFix).first().click();

    /* Then */
    await expect(heading(page, 0)).toBeVisible();
    expect(await questionPanel(page).evaluate(el => el.parentElement?.id)).toBe('terminals');
    // `qp-under` is the contract with the stylesheet, so it is asserted by name.
    await expect(page.locator('.terminal-container.visible.qp-under')).toHaveCount(1);
    expect(await page.evaluate(() => (window as unknown as { __instant: number }).__instant)).toBeGreaterThan(0);
    // Cleared again two frames later.
    await expect(page.locator('#terminals.qp-instant')).toHaveCount(0);

    /* When */
    await sessionRow(page, LABEL.worktreeTry).first().click();

    /* Then */
    await expect(questionPanel(page)).toHaveCount(0);
    await expect(page.locator('.terminal-container.qp-under')).toHaveCount(0);
  });
});

test.describe('keys', () => {
  test('the keyboard answers the whole set', async ({ page, home }) => {
    /* Given */
    const asked = await askedOnScreen(page, home);

    /* When */
    await page.keyboard.press('3');
    await page.keyboard.type('1 2');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowRight');

    /* Then */
    // Typing in Other keeps numbers, space and left/right for the text.
    await expect(otherField(page)).toBeFocused();
    await expect(otherField(page)).toHaveValue('1 2');
    await expect(heading(page, 0)).toBeVisible();
    await expect(option(page, /The whole site/)).toHaveAttribute('aria-pressed', 'false');

    /* When */
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');

    /* Then */
    await expect(option(page, /The whole site/)).toHaveAttribute('aria-pressed', 'true');
    await expect(option(page, /Only \/app/)).toHaveAttribute('aria-pressed', 'false');

    /* When */
    await page.keyboard.press('2');

    /* Then */
    await expect(option(page, /Only \/app/)).toHaveAttribute('aria-pressed', 'true');

    /* When */
    await page.keyboard.press('ArrowRight');
    await expect(heading(page, 1)).toBeVisible();
    await page.keyboard.press('1');
    await page.keyboard.press('3');

    /* Then */
    await expect(option(page, /Unit tests/)).toHaveAttribute('aria-pressed', 'true');
    await expect(option(page, /Lint/)).toHaveAttribute('aria-pressed', 'true');

    /* When */
    // The cursor is on Lint (the last row pressed); space toggles it off.
    await page.keyboard.press(' ');

    /* Then */
    await expect(option(page, /Lint/)).toHaveAttribute('aria-pressed', 'false');

    /* When */
    await page.keyboard.press('ArrowLeft');

    /* Then */
    await expect(heading(page, 0)).toBeVisible();
    await expect(option(page, /Only \/app/)).toHaveAttribute('aria-pressed', 'true');

    /* When */
    await page.keyboard.press('Enter');
    await expect(heading(page, 1)).toBeVisible();
    await page.keyboard.press('2');
    await page.keyboard.press('Enter');

    /* Then */
    const reply = await asked.response as HookReply;
    expect(reply.hookSpecificOutput.updatedInput.answers).toEqual({
      [QUESTIONS[0].question]: 'Only /app',
      [QUESTIONS[1].question]: 'Unit tests, Type check',
    });
  });

  test('unmodified keys stop at the panel; Tab and shortcuts go on', async ({ page, home }) => {
    /* Given */
    await askedOnScreen(page, home);
    await page.evaluate(() => {
      const w = window as unknown as { __keys: string[] };
      w.__keys = [];
      window.addEventListener('keydown', e => w.__keys.push((e.metaKey ? 'Meta+' : '') + e.key));
    });

    /* When */
    await page.keyboard.press('x');
    await page.keyboard.press('n');
    await page.keyboard.press('Meta+k');
    await page.keyboard.press('Tab');

    /* Then */
    const keys = await page.evaluate(() => (window as unknown as { __keys: string[] }).__keys);
    expect(keys).not.toContain('x');
    expect(keys).not.toContain('n');
    expect(keys).toContain('Meta+k');
    expect(keys).toContain('Tab');
  });

  test('Enter or Space on Patch pokes Patch, and Patch keeps focus when a key acts on the panel', async ({ page, home }) => {
    /* Given */
    await askedOnScreen(page, home);
    await pokePatch(page).focus();

    /* When */
    await page.keyboard.press('Enter');

    /* Then */
    await expect(patchSays(page)).toHaveText('Hey! I’m counting.');

    /* When */
    await page.keyboard.press(' ');

    /* Then */
    await expect(patchSays(page)).toHaveText('Hehe. That tickles.');
    // Neither went on to the panel: nothing is picked, the question is the same.
    await expect(option(page, /The whole site/)).toHaveAttribute('aria-pressed', 'false');
    await expect(heading(page, 0)).toBeVisible();

    /* When */
    await page.keyboard.press('2');

    /* Then */
    await expect(option(page, /Only \/app/)).toHaveAttribute('aria-pressed', 'true');
    await expect(pokePatch(page)).toBeFocused();
  });
});

test.describe('terminal', () => {
  test('Esc, the header button and the pill move between the questions and the terminal', async ({ page, home }) => {
    /* When */
    await askedOnScreen(page, home);

    /* Then */
    await expect(toTerminalButton(page)).toBeVisible();
    await expect(toTerminalButton(page)).toContainText('esc');
    await expect(questionSheet(page)).toHaveAttribute('aria-hidden', 'false');
    expect(await questionSheet(page).evaluate(el => (el as HTMLElement).inert)).toBe(false);

    /* When */
    await page.keyboard.press('Escape');

    /* Then */
    await expect(questionPanel(page)).toHaveCount(0);
    await expect(page.locator('.terminal-container.qp-under')).toHaveCount(0);
    await expect(waitingPill(page)).toHaveText('2 questions waiting · Show');
    expect(await focusIsIn(page)).toBe('terminal');
    // Hidden, the sheet is out of the way of assistive tech and the keyboard.
    await expect(questionSheet(page)).toHaveAttribute('aria-hidden', 'true');
    expect(await questionSheet(page).evaluate(el => (el as HTMLElement).inert)).toBe(true);

    /* When */
    await page.keyboard.type('in the terminal');

    /* Then */
    await fakeClaude(home, S.loginFix).waitForInput('in the terminal');

    /* When */
    await waitingPill(page).click();

    /* Then */
    await expect(heading(page, 0)).toBeVisible();
    await expect(patchSays(page)).toHaveText('Welcome back. Right where you left off.');
    await expect(toTerminalButton(page)).toBeVisible();

    /* When */
    await toTerminalButton(page).click();

    /* Then */
    await expect(questionPanel(page)).toHaveCount(0);
    await expect.poll(() => focusIsIn(page)).toBe('terminal');
  });
});

test.describe('peek', () => {
  test('T shows the terminal under the questions and brings them back as they were', async ({ page, home }) => {
    /* Given */
    await askedOnScreen(page, home);
    await page.keyboard.press('2');

    /* When */
    await page.keyboard.press('t');

    /* Then */
    const back = page.getByRole('button', { name: /Back to questions/ });
    await expect(back).toBeVisible();
    await expect(page.locator('.terminal-container.qp-under')).toHaveCount(0);
    await expect(questionSheet(page)).toHaveClass(/is-peeking/);
    expect(await focusIsIn(page)).toBe('panel');

    /* When */
    // Nothing answers while the questions are out of sight, and nothing reaches the terminal.
    await page.keyboard.press('1');
    await page.keyboard.press('t');

    /* Then */
    await expect(back).toHaveCount(0);
    await expect(page.locator('.terminal-container.qp-under')).toHaveCount(1);
    await expect(option(page, /Only \/app/)).toHaveAttribute('aria-pressed', 'true');
    expect(fakeClaude(home, S.loginFix).input()).not.toContain('1');

    /* When */
    await questionPanel(page).getByRole('button', { name: /Peek at terminal/ }).click();
    await back.click();

    /* Then */
    await expect(back).toHaveCount(0);
    await expect(heading(page, 0)).toBeVisible();
    await expect.poll(() => focusIsIn(page)).toBe('panel');
  });
});

test.describe('grilling', () => {
  test('a round written at the end of a turn is answered by typing into the session', async ({ page, home }) => {
    /* Given */
    await openSession(page, home, LABEL.loginFix, S.loginFix);

    /* When */
    await endTurn(home, S.loginFix, ROUND);

    /* Then */
    const panel = questionPanel(page);
    await expect(panel.getByRole('heading', { name: 'Keep the old login route?' })).toBeVisible();
    await expect(panel.getByText('Two clients still call it.')).toBeVisible();
    await expect(panel.getByRole('button', { name: /Keep it for one more release/ })).toBeVisible();
    await expect(sidebar(page).getByText('Asking 2 questions', { exact: true })).toBeVisible();

    /* When */
    await panel.getByRole('button', { name: /Keep it for one more release/ }).click();
    await primary(page).click();
    await expect(panel.getByRole('heading', { name: 'Where do sessions live?' })).toBeVisible();
    await panel.getByRole('button', { name: /B\) Redis/ }).click();
    await primary(page).click();

    /* Then */
    await fakeClaude(home, S.loginFix).waitForInput('Q1: yes\nQ2: B) Redis — shared, needs a server');
    await expect(sidebar(page).getByText('Asking 2 questions', { exact: true })).toHaveCount(0);
  });

  test('a prompt typed in the terminal takes the round away', async ({ page, home }) => {
    /* Given */
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await endTurn(home, S.loginFix, ROUND);
    await expect(questionPanel(page).getByRole('heading', { name: 'Keep the old login route?' })).toBeVisible();

    /* When */
    await submitPrompt(home, S.loginFix, 'Q1: yes');

    /* Then */
    await expect(questionPanel(page)).toHaveCount(0);
    await expect(sidebar(page).getByText('Asking 2 questions', { exact: true })).toHaveCount(0);
  });

});

test.describe('clicks', () => {
  test('tabs, options, Back and the primary button', async ({ page, home }) => {
    /* When */
    await askedOnScreen(page, home);

    /* Then */
    await expect(primary(page)).toHaveText(/^Next/);
    await expect(primary(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(questionPanel(page).getByRole('button', { name: 'Back' })).toBeHidden();
    await expect(tab(page, 'Cookie path')).toHaveAttribute('aria-current', 'step');
    await expect(tab(page, 'Checks')).not.toHaveAttribute('aria-current');
    // Patch speaks through a live status region.
    await expect(patchSays(page)).toHaveAttribute('aria-live', 'polite');
    await expect(patchSays(page)).toHaveText('Claude has 2 questions for you. I’ll keep count!');

    /* When */
    await option(page, /Only \/app/).click();

    /* Then */
    await expect(option(page, /Only \/app/)).toHaveAttribute('aria-pressed', 'true');
    await expect(primary(page)).toHaveAttribute('aria-disabled', 'false');

    /* When */
    // Clicking the picked option of a single-choice question lets go of it.
    await option(page, /Only \/app/).click();

    /* Then */
    await expect(option(page, /Only \/app/)).toHaveAttribute('aria-pressed', 'false');

    /* When */
    await tab(page, 'Checks').click();

    /* Then */
    await expect(heading(page, 1)).toBeVisible();
    await expect(tab(page, 'Checks')).toHaveAttribute('aria-current', 'step');
    await expect(tab(page, 'Cookie path')).not.toHaveAttribute('aria-current');
    await expect(primary(page)).toHaveText(/^Send answers/);
    await expect(primary(page)).toHaveAttribute('aria-disabled', 'true');

    /* When */
    await questionPanel(page).getByRole('button', { name: 'Back' }).click();

    /* Then */
    await expect(heading(page, 0)).toBeVisible();

    /* When */
    await option(page, /Only \/app/).click();
    await primary(page).click();

    /* Then */
    await expect(heading(page, 1)).toBeVisible();
  });
});

test.describe('switching sessions', () => {
  test('a draft and the keyboard survive switching away and back', async ({ page, home }) => {
    /* Given */
    await openSession(page, home, LABEL.worktreeTry, S.worktreeTry);
    await askedOnScreen(page, home);
    await option(page, /Only \/app/).click();
    await page.keyboard.press('Enter');
    await expect(heading(page, 1)).toBeVisible();

    /* When */
    await option(page, /Lint/).click();

    /* Then */
    await expect(patchSays(page)).toHaveText('That’s everything. Send it!');

    /* When */
    await sessionRow(page, LABEL.worktreeTry).first().click();

    /* Then */
    await expect(questionPanel(page)).toHaveCount(0);

    /* When */
    await sessionRow(page, LABEL.loginFix).first().click();

    /* Then */
    await expect(heading(page, 1)).toBeVisible();
    await expect(option(page, /Lint/)).toHaveAttribute('aria-pressed', 'true');
    // Patch picks up where it was rather than greeting again.
    await expect(patchSays(page)).toHaveText('That’s everything. Send it!');
    // Showing the session focuses its terminal; the questions take the keyboard back.
    await expect.poll(() => focusIsIn(page)).toBe('panel');
  });
});

test.describe('motion', () => {
  test('the check mark pops; a question leaves over 140ms, holding keys, then comes in over 260ms', async ({ page, home }) => {
    /* Given */
    await askedOnScreen(page, home);
    await recordAnimations(page);

    /* When */
    await option(page, /The whole site/).click();

    /* Then */
    await expect.poll(async () =>
      (await recordedAnimations(page)).filter(a => a.target === 'svg').map(a => a.duration)).toEqual([220]);

    /* When */
    await recordedAnimations(page, { clear: true });
    // Next, then a key that would pick on the next question, in the same task.
    await keysAtOnce(page, ['Enter', '1']);

    /* Then */
    await expect(heading(page, 1)).toBeVisible();
    await expect(option(page, /Unit tests/)).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => (await recordedAnimations(page)).filter(a => a.duration === 260).length)
      .toBe(5);
    const animations = await recordedAnimations(page);
    const out = animations.find(a => a.duration === 140);
    expect(out, 'the question leaving').toBeTruthy();
    const ins = animations.filter(a => a.duration === 260);
    // The block, then each of its four rows (three options and Other), 35ms apart.
    expect(ins.map(a => a.delay)).toEqual([0, 60, 95, 130, 165]);
    expect(ins[0].at - out!.at).toBeGreaterThanOrEqual(130);
  });
});

test.describe('send', () => {
  test('a farewell Patch comes 280ms after sending and stays about 3.2s', async ({ page, home }) => {
    /* Given */
    const asked = await askedOnScreen(page, home, QUESTIONS.slice(0, 1));
    await option(page, /The whole site/).click();
    await recordAnimations(page);

    /* When */
    await page.keyboard.press('Enter');
    await asked.response;

    /* Then */
    const farewell = page.getByText('Off it goes!');
    await expect(farewell).toBeVisible();
    const arrival = (await recordedAnimations(page)).find(a => a.target === 'div.qp-farewell');
    expect(arrival?.delay).toBe(280);
    await page.waitForTimeout(2500);
    await expect(farewell).toBeVisible();
    await expect(farewell).toHaveCount(0, { timeout: 2000 });
  });

  test('a new set sends the farewell away', async ({ page, home }) => {
    /* Given */
    const asked = await askedOnScreen(page, home, QUESTIONS.slice(0, 1));
    await option(page, /The whole site/).click();
    await page.keyboard.press('Enter');
    await asked.response;
    await expect(page.getByText('Off it goes!')).toBeVisible();

    /* When */
    await askQuestions(home, S.loginFix, QUESTIONS.slice(1));

    /* Then */
    await expect(heading(page, 1)).toBeVisible();
    await expect(page.getByText('Off it goes!')).toHaveCount(0, { timeout: 1000 });
  });

  test('a set main has already withdrawn settles without a farewell', async ({ page, home, app }) => {
    /* Given */
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await pushQuestions(app, S.loginFix, QUESTIONS.slice(0, 1));
    await expect(heading(page, 0)).toBeVisible();
    await option(page, /The whole site/).click();

    /* When */
    await page.keyboard.press('Enter');

    /* Then */
    await expect(questionPanel(page)).toHaveCount(0);
    await page.waitForTimeout(500);
    await expect(page.getByText('Off it goes!')).toHaveCount(0);
  });
});

test.describe('doze', () => {
  test('Patch says when the terminal takes over', async ({ page, home, app }) => {
    /* Given */
    await openSession(page, home, LABEL.loginFix, S.loginFix);

    /* When */
    await pushQuestions(app, S.loginFix, QUESTIONS.slice(0, 1), { deadlineInMs: 150_000 });

    /* Then */
    await expect(heading(page, 0)).toBeVisible();
    await expect(patchSays(page)).toHaveText('Claude has a question for you. I’ll keep count!');
    // Once a minute at most, and not while plenty of time is left: test/question-copy.test.ts.
    await expect(patchSays(page)).toHaveText('Still here. The terminal takes over in 3 min.', { timeout: 7000 });
  });
});

forEachAppearance(() => {
  test('question panel, multiple choice', async ({ page, home }) => {
    /* Given */
    await askedOnScreen(page, home, QUESTIONS, { reducedMotion: true });
    await option(page, /The whole site/).click();
    await primary(page).click();
    await expect(heading(page, 1)).toBeVisible();

    /* When */
    await option(page, /Unit tests/).click();
    await option(page, /Lint/).click();

    /* Then */
    await expect(patchSays(page)).toHaveText('Two picked. Any more?');
    await expectScreen(page, 'question-panel-multi');
  });

  test('question header pill', async ({ page, home }) => {
    /* Given */
    await askedOnScreen(page, home, QUESTIONS, { reducedMotion: true });

    /* When */
    await toTerminalButton(page).click();

    /* Then */
    await expect(waitingPill(page)).toBeVisible();
    await expectScreen(page, 'question-pill');
  });
});
