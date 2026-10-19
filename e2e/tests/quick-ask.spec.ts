/**
 * The Quick Ask pop-up (#148): its own window, opened by ⌥Space's stand-in.
 *
 * Its rules are unit tested (test/quick-ask-slice.test.ts,
 * test/quick-ask-keys.test.ts). These walk the wired window: the hook shows
 * it, the text crosses IPC, and main answers. Until #149 brings the routing,
 * main's answer is a stand-in, told by the test which reply to give.
 *
 * Under the harness the window never comes on screen; whether it is showing
 * is main's word (`quickAskShowing`), and a click away is the window losing
 * the focus, sent to the page as the OS would.
 */
import { test, expect, forEachAppearance } from '../support/test';
import {
  answerQuickAsk, pressQuickAsk, quickAskPassingThrough, quickAskShowing,
} from '../support/main-process';
import { expectPopUp, quickAskPage } from '../support/quick-ask';
import type { ElectronApplication, Page } from '@playwright/test';

const TEXT = 'fix the flaky upload test';

const box = (popUp: Page) => popUp.getByTestId('ask-box');
const line = (popUp: Page) => popUp.getByTestId('quick-ask-line');
const choices = (popUp: Page) => popUp.getByRole('listbox', { name: 'Projects' });

/** Press ⌥Space and wait for the pop-up to say it has shown. */
async function open(app: ElectronApplication): Promise<Page> {
  const popUp = await quickAskPage(app);
  expect(await pressQuickAsk(app)).toBe(true);
  await expect.poll(() => quickAskShowing(app)).toBe(true);
  return popUp;
}

async function clickAway(popUp: Page): Promise<void> {
  await popUp.evaluate(() => window.dispatchEvent(new Event('blur')));
}

async function selection(popUp: Page): Promise<[number, number]> {
  return await box(popUp).evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]);
}

test('the hook opens it, and the box has the focus at once', async ({ app }) => {
  /* When */
  const popUp = await open(app);

  /* Then */
  await expect(box(popUp)).toBeFocused();
  await expect(box(popUp)).toHaveValue('');
});

test('Esc closes it, and the draft is there, selected, when it reopens', async ({ app }) => {
  /* Given */
  const popUp = await open(app);
  await box(popUp).fill(TEXT);

  /* When */
  await box(popUp).press('Escape');

  /* Then */
  await expect.poll(() => quickAskShowing(app)).toBe(false);

  /* When */
  await open(app);

  /* Then */
  await expect(box(popUp)).toBeFocused();
  await expect(box(popUp)).toHaveValue(TEXT);
  expect(await selection(popUp)).toEqual([0, TEXT.length]);
});

test('a click away closes it, and so does ⌥Space, keeping the draft', async ({ app }) => {
  /* Given */
  const popUp = await open(app);
  await box(popUp).fill(TEXT);

  /* When */
  await clickAway(popUp);

  /* Then */
  await expect.poll(() => quickAskShowing(app)).toBe(false);

  /* When */
  await open(app);
  await pressQuickAsk(app);

  /* Then */
  await expect.poll(() => quickAskShowing(app)).toBe(false);
  await open(app);
  await expect(box(popUp)).toHaveValue(TEXT);
});

test('while it waits nothing closes it, and Esc cancels and unlocks the box', async ({ app }) => {
  /* Given */
  await answerQuickAsk(app, 'started', 60_000);
  const popUp = await open(app);
  await box(popUp).fill(TEXT);
  await box(popUp).press('Enter');
  await expect(box(popUp)).toHaveAttribute('aria-busy', 'true');

  /* When */
  await clickAway(popUp);
  await pressQuickAsk(app);

  /* Then */
  await popUp.waitForTimeout(300);
  expect(await quickAskShowing(app)).toBe(true);
  await expect(box(popUp)).not.toBeEditable();

  /* When */
  await box(popUp).press('Escape');

  /* Then */
  await expect(box(popUp)).toHaveAttribute('aria-busy', 'false');
  await expect(box(popUp)).toBeEditable();
  await expect(box(popUp)).toHaveValue(TEXT);
  expect(await quickAskShowing(app)).toBe(true);
});

test('an unsure answer lists three; ↑↓ move, and Enter starts the one picked', async ({ app }) => {
  /* Given */
  await answerQuickAsk(app, 'choose', 100);
  const popUp = await open(app);
  await box(popUp).fill(TEXT);

  /* When */
  await box(popUp).press('Enter');

  /* Then */
  await expect(choices(popUp).getByRole('option')).toHaveCount(3);
  await expect(choices(popUp).getByRole('option', { selected: true })).toHaveText('example');

  /* When */
  await box(popUp).press('ArrowDown');
  await box(popUp).press('ArrowDown');
  await box(popUp).press('ArrowUp');

  /* Then */
  await expect(choices(popUp).getByRole('option', { selected: true })).toHaveText('example-api');

  /* When */
  await box(popUp).press('Enter');

  /* Then */
  await expect(line(popUp)).toHaveText('Started in example-api');
  await expect.poll(() => quickAskShowing(app)).toBe(false);
});

test('Esc while choosing closes the list, and the text is there to edit', async ({ app }) => {
  /* Given */
  await answerQuickAsk(app, 'choose', 100);
  const popUp = await open(app);
  await box(popUp).fill(TEXT);
  await box(popUp).press('Enter');
  await expect(choices(popUp)).toBeVisible();

  /* When */
  await box(popUp).press('Escape');

  /* Then */
  await expect(choices(popUp)).toBeHidden();
  await expect(box(popUp)).toBeEditable();
  await expect(box(popUp)).toHaveValue(TEXT);
  expect(await quickAskShowing(app)).toBe(true);
});

test('a sure answer says where it started, closes after a moment, and the next box is empty', async ({ app }) => {
  /* Given */
  await answerQuickAsk(app, 'started', 100);
  const popUp = await open(app);
  await box(popUp).fill(TEXT);

  /* When */
  await box(popUp).press('Enter');

  /* Then */
  await expect(line(popUp)).toHaveText('Started in example');
  expect(await quickAskShowing(app)).toBe(true);
  await expect.poll(() => quickAskShowing(app)).toBe(false);

  /* When */
  await open(app);

  /* Then */
  await expect(box(popUp)).toHaveValue('');
  await expect(line(popUp)).toBeHidden();
});

test('a hand-off to the main window closes it and keeps the draft', async ({ app }) => {
  /* Given */
  await answerQuickAsk(app, 'handedOff', 100);
  const popUp = await open(app);
  await box(popUp).fill(TEXT);

  /* When */
  await box(popUp).press('Enter');

  /* Then */
  await expect.poll(() => quickAskShowing(app)).toBe(false);
  await open(app);
  await expect(box(popUp)).toHaveValue(TEXT);
});

test('only the slab takes the mouse: beside it, a click goes to the window underneath', async ({ app }) => {
  /* Given */
  const popUp = await open(app);
  const slab = await popUp.getByTestId('quick-ask').boundingBox();

  /* When */
  await popUp.mouse.move(slab!.x + slab!.width / 2, slab!.y + slab!.height / 2);

  /* Then */
  await expect.poll(() => quickAskPassingThrough(app)).toBe(false);

  /* When */
  await popUp.mouse.move(slab!.x + slab!.width / 2, slab!.y + slab!.height + 100);

  /* Then */
  await expect.poll(() => quickAskPassingThrough(app)).toBe(true);
});

forEachAppearance(() => {
  test('each state of the pop-up', async ({ app }) => {
    /* Given */
    await answerQuickAsk(app, 'choose', 1_500);
    const popUp = await open(app);
    await box(popUp).fill(TEXT);

    /* Then */
    await expectPopUp(popUp, 'quick-ask-editing');

    /* When */
    await box(popUp).press('Enter');

    /* Then */
    await expect(line(popUp)).toHaveText('Thinking…');
    await expectPopUp(popUp, 'quick-ask-waiting');
    await expect(choices(popUp).getByRole('option')).toHaveCount(3);
    await expectPopUp(popUp, 'quick-ask-choosing');

    /* When */
    await box(popUp).press('Enter');

    /* Then */
    await expect(line(popUp)).toHaveText('Started in example');
    await expectPopUp(popUp, 'quick-ask-started');
  });
});
