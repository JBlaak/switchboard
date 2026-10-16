/**
 * The question panel: an AskUserQuestion posted to the session's hook, shown
 * over the terminal, and answered from Switchboard.
 */
import { test, expect, forEachAppearance } from '../support/test';
import { expectScreen, openSession, sessionRow, sidebar, terminalHeader } from '../support/app';
import {
  askQuestions, focusIsIn, option, pushQuestions, pushSettled, questionSheet, recordAnimations,
  recordedAnimations,
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

// ── The panel, item by item ──

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

test.describe('data', () => {
  test('a set pending before the window loaded comes up after a reload', async ({ page, home }) => {
    await askedOnScreen(page, home);
    await page.reload();
    await expect(heading(page, 0)).toBeVisible();
  });

  test('a settled tool-use id never comes back', async ({ page, home, app }) => {
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await pushSettled(app, S.loginFix, 'toolu_gone');
    await pushQuestions(app, S.loginFix, QUESTIONS.slice(0, 1), { toolUseId: 'toolu_gone' });
    await page.waitForTimeout(300);
    await expect(questionPanel(page)).toHaveCount(0);
    // The same push with a fresh id does come up, so the one above was refused rather than slow.
    await pushQuestions(app, S.loginFix, QUESTIONS.slice(0, 1), { toolUseId: 'toolu_fresh' });
    await expect(heading(page, 0)).toBeVisible();
  });
});

test.describe('placement', () => {
  test('the sheet sits over the terminals and sinks the terminal under it', async ({ page, home }) => {
    await askedOnScreen(page, home);
    expect(await questionPanel(page).evaluate(el => el.parentElement?.id)).toBe('terminals');
    // `qp-under` is the contract with the stylesheet, so it is asserted by name.
    await expect(page.locator('.terminal-container.visible.qp-under')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.terminal-container.qp-under')).toHaveCount(0);
  });

  test('follows the session on screen, landing without transitions', async ({ page, home }) => {
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await openSession(page, home, LABEL.worktreeTry, S.worktreeTry);
    await askQuestions(home, S.loginFix, QUESTIONS);
    await expect(sidebar(page).getByText('Asking 2 questions', { exact: true })).toBeVisible();
    // Asked behind the session on screen: nothing comes up over it.
    await expect(questionPanel(page)).toHaveCount(0);
    await expect(page.locator('.terminal-container.qp-under')).toHaveCount(0);

    await page.evaluate(() => {
      const terminals = document.getElementById('terminals')!;
      const w = window as unknown as { __instant: number };
      w.__instant = 0;
      new MutationObserver(() => { if (terminals.classList.contains('qp-instant')) w.__instant++; })
        .observe(terminals, { attributes: true, attributeFilter: ['class'] });
    });
    await sessionRow(page, LABEL.loginFix).first().click();
    await expect(heading(page, 0)).toBeVisible();
    await expect(page.locator('.terminal-container.visible.qp-under')).toHaveCount(1);
    expect(await page.evaluate(() => (window as unknown as { __instant: number }).__instant)).toBeGreaterThan(0);
    // Cleared again two frames later.
    await expect(page.locator('#terminals.qp-instant')).toHaveCount(0);

    await sessionRow(page, LABEL.worktreeTry).first().click();
    await expect(questionPanel(page)).toHaveCount(0);
    await expect(page.locator('.terminal-container.qp-under')).toHaveCount(0);
  });
});

test.describe('keys', () => {
  test('arrows move and pick, Enter goes on, Enter on the last sends', async ({ page, home }) => {
    const asked = await askedOnScreen(page, home);
    await page.keyboard.press('ArrowDown');
    await expect(option(page, /Only \/app/)).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('ArrowUp');
    await expect(option(page, /The whole site/)).toHaveAttribute('aria-pressed', 'true');
    await expect(option(page, /Only \/app/)).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('Enter');
    await expect(heading(page, 1)).toBeVisible();

    await page.keyboard.press('2');
    await page.keyboard.press('Enter');
    const reply = await asked.response as { hookSpecificOutput: { updatedInput: { answers: Record<string, string> } } };
    expect(reply.hookSpecificOutput.updatedInput.answers).toEqual({
      [QUESTIONS[0].question]: 'The whole site (Recommended)',
      [QUESTIONS[1].question]: 'Type check',
    });
  });

  test('numbers pick, space toggles, left and right change question', async ({ page, home }) => {
    await askedOnScreen(page, home);
    await page.keyboard.press('2');
    await expect(option(page, /Only \/app/)).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('ArrowRight');
    await expect(heading(page, 1)).toBeVisible();
    await page.keyboard.press('1');
    await page.keyboard.press('3');
    await expect(option(page, /Unit tests/)).toHaveAttribute('aria-pressed', 'true');
    await expect(option(page, /Lint/)).toHaveAttribute('aria-pressed', 'true');
    // The cursor is on Lint (the last row pressed); space toggles it off.
    await page.keyboard.press(' ');
    await expect(option(page, /Lint/)).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('ArrowLeft');
    await expect(heading(page, 0)).toBeVisible();
    await expect(option(page, /Only \/app/)).toHaveAttribute('aria-pressed', 'true');
  });

  test('typing in Other keeps numbers, space and left/right for the text', async ({ page, home }) => {
    await askedOnScreen(page, home);
    await page.keyboard.press('3');
    await expect(otherField(page)).toBeFocused();
    await page.keyboard.type('1 2');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowRight');
    await expect(otherField(page)).toHaveValue('1 2');
    await expect(heading(page, 0)).toBeVisible();
    await expect(option(page, /The whole site/)).toHaveAttribute('aria-pressed', 'false');
    // Enter still goes on from the field.
    await page.keyboard.press('Enter');
    await expect(heading(page, 1)).toBeVisible();
  });

  test('Esc answers in the terminal instead', async ({ page, home }) => {
    await askedOnScreen(page, home);
    await page.keyboard.press('Escape');
    await expect(questionPanel(page)).toHaveCount(0);
    expect(await focusIsIn(page)).toBe('terminal');
    await page.keyboard.type('in the terminal');
    await fakeClaude(home, S.loginFix).waitForInput('in the terminal');
  });

  test('unmodified keys stop at the panel; Tab and shortcuts go on', async ({ page, home }) => {
    await askedOnScreen(page, home);
    await page.evaluate(() => {
      const w = window as unknown as { __keys: string[] };
      w.__keys = [];
      window.addEventListener('keydown', e => w.__keys.push((e.metaKey ? 'Meta+' : '') + e.key));
    });
    await page.keyboard.press('x');
    await page.keyboard.press('n');
    await page.keyboard.press('Meta+k');
    await page.keyboard.press('Tab');
    const keys = await page.evaluate(() => (window as unknown as { __keys: string[] }).__keys);
    expect(keys).not.toContain('x');
    expect(keys).not.toContain('n');
    expect(keys).toContain('Meta+k');
    expect(keys).toContain('Tab');
  });

  test('keys during IME composition are left alone', async ({ page, home }) => {
    await askedOnScreen(page, home);
    await page.evaluate(() => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', {
        key: '2', isComposing: true, bubbles: true, cancelable: true,
      }));
    });
    await expect(option(page, /Only \/app/)).toHaveAttribute('aria-pressed', 'false');
    await keysAtOnce(page, ['2']);
    await expect(option(page, /Only \/app/)).toHaveAttribute('aria-pressed', 'true');
  });

  test('Enter or Space on Patch pokes Patch', async ({ page, home }) => {
    await askedOnScreen(page, home);
    await pokePatch(page).focus();
    await page.keyboard.press('Enter');
    await expect(patchSays(page)).toHaveText('Hey! I’m counting.');
    await page.keyboard.press(' ');
    await expect(patchSays(page)).toHaveText('Hehe. That tickles.');
    // Neither went on to the panel: nothing is picked, the question is the same.
    await expect(option(page, /The whole site/)).toHaveAttribute('aria-pressed', 'false');
    await expect(heading(page, 0)).toBeVisible();
  });
});

test.describe('clicks', () => {
  test('tabs, options, Back and the primary button', async ({ page, home }) => {
    await askedOnScreen(page, home);
    await expect(primary(page)).toHaveText(/^Next/);
    await expect(primary(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(questionPanel(page).getByRole('button', { name: 'Back' })).toBeHidden();

    await option(page, /Only \/app/).click();
    await expect(option(page, /Only \/app/)).toHaveAttribute('aria-pressed', 'true');
    await expect(primary(page)).toHaveAttribute('aria-disabled', 'false');
    // Clicking the picked option of a single-choice question lets go of it.
    await option(page, /Only \/app/).click();
    await expect(option(page, /Only \/app/)).toHaveAttribute('aria-pressed', 'false');

    await tab(page, 'Checks').click();
    await expect(heading(page, 1)).toBeVisible();
    await expect(primary(page)).toHaveText(/^Send answers/);
    await expect(primary(page)).toHaveAttribute('aria-disabled', 'true');
    await questionPanel(page).getByRole('button', { name: 'Back' }).click();
    await expect(heading(page, 0)).toBeVisible();

    await option(page, /Only \/app/).click();
    await primary(page).click();
    await expect(heading(page, 1)).toBeVisible();
  });

  test('focusing the Other field chooses Other', async ({ page, home }) => {
    await askedOnScreen(page, home);
    await option(page, /The whole site/).click();
    await expect(option(page, /The whole site/)).toHaveAttribute('aria-pressed', 'true');
    await otherField(page).click();
    await expect(option(page, /The whole site/)).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.type('Only on /beta');
    await expect(primary(page)).toHaveAttribute('aria-disabled', 'false');
  });
});

test.describe('focus', () => {
  test('the panel takes the keyboard while it is up, and gives it back when its set settles', async ({ page, home }) => {
    const asked = await askedOnScreen(page, home);
    expect(await focusIsIn(page)).toBe('panel');
    asked.abandon();
    await expect(questionPanel(page)).toHaveCount(0);
    await expect.poll(() => focusIsIn(page)).toBe('terminal');
  });

  test('showing the session again keeps the keyboard on the questions', async ({ page, home }) => {
    await askedOnScreen(page, home);
    await sessionRow(page, LABEL.loginFix).first().click();
    await expect.poll(() => focusIsIn(page)).toBe('panel');
  });

  test('Patch keeps focus when a key acts on the panel', async ({ page, home }) => {
    await askedOnScreen(page, home);
    await pokePatch(page).focus();
    await page.keyboard.press('2');
    await expect(option(page, /Only \/app/)).toHaveAttribute('aria-pressed', 'true');
    await expect(pokePatch(page)).toBeFocused();
  });

  test('a draft survives switching sessions', async ({ page, home }) => {
    await openSession(page, home, LABEL.worktreeTry, S.worktreeTry);
    await askedOnScreen(page, home);
    await option(page, /Only \/app/).click();
    await page.keyboard.press('Enter');
    await expect(heading(page, 1)).toBeVisible();
    await option(page, /Lint/).click();
    await expect(patchSays(page)).toHaveText('That’s everything. Send it!');

    await sessionRow(page, LABEL.worktreeTry).first().click();
    await expect(questionPanel(page)).toHaveCount(0);
    await sessionRow(page, LABEL.loginFix).first().click();
    await expect(heading(page, 1)).toBeVisible();
    await expect(option(page, /Lint/)).toHaveAttribute('aria-pressed', 'true');
    // Patch picks up where it was rather than greeting again.
    await expect(patchSays(page)).toHaveText('That’s everything. Send it!');
  });
});

test.describe('motion', () => {
  test('a question leaves over 140ms, holding keys, then comes in over 260ms', async ({ page, home }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await askedOnScreen(page, home);
    await option(page, /The whole site/).click();
    await recordAnimations(page);
    // Next, then a key that would pick on the next question, in the same task.
    await keysAtOnce(page, ['Enter', '1']);
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

  test('the check mark pops as an option is chosen', async ({ page, home }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await askedOnScreen(page, home);
    await recordAnimations(page);
    await option(page, /The whole site/).click();
    await expect.poll(async () =>
      (await recordedAnimations(page)).filter(a => a.target === 'svg').map(a => a.duration)).toEqual([220]);
  });
});

test.describe('header button', () => {
  test('answer in terminal while up, the waiting pill while not', async ({ page, home }) => {
    await askedOnScreen(page, home);
    await expect(toTerminalButton(page)).toBeVisible();
    await expect(toTerminalButton(page)).toContainText('esc');

    await toTerminalButton(page).click();
    await expect(questionPanel(page)).toHaveCount(0);
    await expect(waitingPill(page)).toHaveText('2 questions waiting · Show');
    expect(await focusIsIn(page)).toBe('terminal');

    await waitingPill(page).click();
    await expect(heading(page, 0)).toBeVisible();
    await expect(patchSays(page)).toHaveText('Welcome back. Right where you left off.');
    await expect(toTerminalButton(page)).toBeVisible();
  });

  test('the pill counts what is left to answer', async ({ page, home }) => {
    await askedOnScreen(page, home);
    await option(page, /The whole site/).click();
    await page.keyboard.press('Escape');
    await expect(waitingPill(page)).toHaveText('1 question waiting · Show');
  });

  test('is rebuilt only when what it says changes', async ({ page, home }) => {
    await askedOnScreen(page, home);
    await toTerminalButton(page).evaluate(el => { (el as unknown as { kept: boolean }).kept = true; });
    await option(page, /The whole site/).click();
    await page.keyboard.press('Enter');
    await expect(heading(page, 1)).toBeVisible();
    expect(await toTerminalButton(page).evaluate(el => (el as unknown as { kept?: boolean }).kept)).toBe(true);
    await page.keyboard.press('Escape');
    expect(await waitingPill(page).evaluate(el => (el as unknown as { kept?: boolean }).kept)).toBeUndefined();
  });

  test('is gone once the set is settled', async ({ page, home }) => {
    const asked = await askedOnScreen(page, home);
    asked.abandon();
    await expect(toTerminalButton(page)).toHaveCount(0);
    await expect(waitingPill(page)).toHaveCount(0);
  });
});

test.describe('send', () => {
  test('a farewell Patch comes 280ms after sending and stays about 3.2s', async ({ page, home }) => {
    const asked = await askedOnScreen(page, home, QUESTIONS.slice(0, 1));
    await option(page, /The whole site/).click();
    await recordAnimations(page);
    await page.keyboard.press('Enter');
    await asked.response;
    const farewell = page.getByText('Off it goes!');
    await expect(farewell).toBeVisible();
    const arrival = (await recordedAnimations(page)).find(a => a.target === 'div.qp-farewell');
    expect(arrival?.delay).toBe(280);
    await page.waitForTimeout(2500);
    await expect(farewell).toBeVisible();
    await expect(farewell).toHaveCount(0, { timeout: 2000 });
  });

  test('a new set sends the farewell away', async ({ page, home }) => {
    const asked = await askedOnScreen(page, home, QUESTIONS.slice(0, 1));
    await option(page, /The whole site/).click();
    await page.keyboard.press('Enter');
    await asked.response;
    await expect(page.getByText('Off it goes!')).toBeVisible();
    await askQuestions(home, S.loginFix, QUESTIONS.slice(1));
    await expect(heading(page, 1)).toBeVisible();
    await expect(page.getByText('Off it goes!')).toHaveCount(0, { timeout: 1000 });
  });

  test('a set main has already withdrawn settles without a farewell', async ({ page, home, app }) => {
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await pushQuestions(app, S.loginFix, QUESTIONS.slice(0, 1));
    await expect(heading(page, 0)).toBeVisible();
    await option(page, /The whole site/).click();
    await page.keyboard.press('Enter');
    await expect(questionPanel(page)).toHaveCount(0);
    await page.waitForTimeout(500);
    await expect(page.getByText('Off it goes!')).toHaveCount(0);
  });
});

test.describe('doze', () => {
  test('Patch says when the terminal takes over, once a minute', async ({ page, home, app }) => {
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await pushQuestions(app, S.loginFix, QUESTIONS.slice(0, 1), { deadlineInMs: 150_000 });
    await expect(heading(page, 0)).toBeVisible();
    await expect(patchSays(page)).toHaveText('Claude has a question for you. I’ll keep count!');
    await expect(patchSays(page)).toHaveText('Still here. The terminal takes over in 3 min.', { timeout: 7000 });
    // The renderer's clock is frozen, so the minute never changes: no second reminder.
    await pokePatch(page).click();
    await expect(patchSays(page)).toHaveText('Hey! I’m counting.');
    await page.waitForTimeout(6000);
    await expect(patchSays(page)).toHaveText('Hey! I’m counting.');
  });

  test('stays quiet while plenty of time is left', async ({ page, home, app }) => {
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await pushQuestions(app, S.loginFix, QUESTIONS.slice(0, 1), { deadlineInMs: 600_000 });
    await expect(heading(page, 0)).toBeVisible();
    await page.waitForTimeout(6000);
    await expect(patchSays(page)).toHaveText('Claude has a question for you. I’ll keep count!');
  });
});

test.describe('accessibility', () => {
  test('hidden, the sheet is inert and aria-hidden; up, it is neither', async ({ page, home }) => {
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await expect(questionSheet(page)).toHaveAttribute('aria-hidden', 'true');
    expect(await questionSheet(page).evaluate(el => (el as HTMLElement).inert)).toBe(true);

    await askQuestions(home, S.loginFix, QUESTIONS);
    await expect(heading(page, 0)).toBeVisible();
    await expect(questionSheet(page)).toHaveAttribute('aria-hidden', 'false');
    expect(await questionSheet(page).evaluate(el => (el as HTMLElement).inert)).toBe(false);

    await toTerminalButton(page).click();
    await expect(questionSheet(page)).toHaveAttribute('aria-hidden', 'true');
    expect(await questionSheet(page).evaluate(el => (el as HTMLElement).inert)).toBe(true);
  });

  test('Patch speaks through a live status region', async ({ page, home }) => {
    await askedOnScreen(page, home);
    await expect(patchSays(page)).toHaveAttribute('aria-live', 'polite');
    await expect(patchSays(page)).toHaveText('Claude has 2 questions for you. I’ll keep count!');
    await option(page, /The whole site/).click();
    await expect(patchSays(page)).toHaveText('Good call. Claude liked that one too.');
  });

  test('options say whether they are pressed, tabs which is current', async ({ page, home }) => {
    await askedOnScreen(page, home);
    await expect(option(page, /The whole site/)).toHaveAttribute('aria-pressed', 'false');
    await expect(tab(page, 'Cookie path')).toHaveAttribute('aria-current', 'step');
    await expect(tab(page, 'Checks')).not.toHaveAttribute('aria-current');
    await tab(page, 'Checks').click();
    await expect(tab(page, 'Checks')).toHaveAttribute('aria-current', 'step');
    await expect(tab(page, 'Cookie path')).not.toHaveAttribute('aria-current');
  });
});

forEachAppearance(() => {
  test('question panel, multiple choice', async ({ page, home }) => {
    await askedOnScreen(page, home, QUESTIONS, { reducedMotion: true });
    await option(page, /The whole site/).click();
    await primary(page).click();
    await expect(heading(page, 1)).toBeVisible();
    await option(page, /Unit tests/).click();
    await option(page, /Lint/).click();
    await expect(patchSays(page)).toHaveText('Two picked. Any more?');
    await expectScreen(page, 'question-panel-multi');
  });

  test('question panel, other', async ({ page, home }) => {
    await askedOnScreen(page, home, QUESTIONS, { reducedMotion: true });
    await otherField(page).click();
    await page.keyboard.type('Only on the beta domain');
    await expect(patchSays(page)).toHaveText('Ooh, writing your own answer.');
    await expectScreen(page, 'question-panel-other');
  });

  test('question header pill', async ({ page, home }) => {
    await askedOnScreen(page, home, QUESTIONS, { reducedMotion: true });
    await toTerminalButton(page).click();
    await expect(waitingPill(page)).toBeVisible();
    await expectScreen(page, 'question-pill');
  });
});
