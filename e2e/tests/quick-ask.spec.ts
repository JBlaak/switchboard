/**
 * Quick Ask (#148, #149): the pop-up, opened by ⌥Space's stand-in, and the
 * session it starts in the main window.
 *
 * Its rules are unit tested (test/quick-ask-slice.test.ts,
 * test/quick-ask-keys.test.ts, test/quick-ask-service.test.ts). These walk
 * the wired app: the hook shows the pop-up, the text crosses IPC, main sends
 * it to the fake `claude -p` the pop-up warmed as it showed, and the answer
 * starts a session in the main window, lists the choices, or hands the text
 * to the main window's New Session picker.
 *
 * Under the harness the pop-up never comes on screen; whether it is showing
 * is main's word (`quickAskShowing`), and a click away is the window losing
 * the focus, sent to the page as the OS would.
 */
import { test, expect, forEachAppearance } from '../support/test';
import { dialog, sessionRow } from '../support/app';
import { fakeRoute, launchedKeys, waitForNewLaunch } from '../support/fake-cli';
import {
  closeMainWindow, mainWindowFocusCalls, mainWindowFocused, pressQuickAsk, quickAskPassingThrough,
  quickAskShowing, watchMainWindowFocus,
} from '../support/main-process';
import { mainWindow } from '../support/launch';
import { expectPopUp, quickAskPage } from '../support/quick-ask';
import { P } from '../fixtures/standard';
import type { ElectronApplication, Page } from '@playwright/test';
import type { FakeRoute } from '../support/fake-cli';
import type { FixtureHome } from '../support/fixture-home';

const TEXT = 'fix the flaky upload test';
const NO_MATCH_LINE = 'Hmm, I couldn’t tell which project that’s for. Pick one?';

const box = (popUp: Page) => popUp.getByTestId('ask-box');
const line = (popUp: Page) => popUp.getByTestId('quick-ask-line');
const choices = (popUp: Page) => popUp.getByRole('listbox', { name: 'Projects' });
const says = (page: Page, text: string) => page.locator('#placeholder').getByText(text);

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

/** Patch is sure: acme-api, on `prompt`. */
function answerSure(route: FakeRoute, home: FixtureHome, prompt: string, delayMs = 0): void {
  const acmeApi = home.projectPath(P.acmeApi);
  route.answer({ projectPath: acmeApi, confident: true, candidates: [acmeApi], prompt }, delayMs);
}

/** Patch is unsure between three projects, acme-api first. */
function answerUnsure(route: FakeRoute, home: FixtureHome, prompt: string, delayMs = 0): void {
  const candidates = [P.acmeApi, P.webDashboard, P.notes].map(relative => home.projectPath(relative));
  route.answer({ projectPath: candidates[0], confident: false, candidates, prompt }, delayMs);
}

/** Nothing fits. */
function answerNoMatch(route: FakeRoute): void {
  route.answer({ projectPath: null, confident: false, candidates: [], prompt: '' });
}

/** Set the Quick Session Folder, as a save in global settings does. */
async function setQuickSessionFolder(page: Page, folder: string): Promise<void> {
  await page.evaluate(async (folder) => {
    const global = await window.api.getSetting<Record<string, unknown>>('global');
    await window.api.setSetting('global', { ...global, quickSessionPath: folder });
  }, folder);
}

// ── The pop-up ──

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

test('while it waits nothing closes it, and Esc cancels and unlocks the box', async ({ app, home }) => {
  /* Given */
  const route = fakeRoute(home);
  answerSure(route, home, 'Too late.', 5_000);
  const before = launchedKeys(home);
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
  await popUp.waitForTimeout(5_500);
  expect([...launchedKeys(home)].filter(key => !before.has(key))).toEqual([]);
});

test('Esc while choosing closes the list, and the text is there to edit', async ({ app, home }) => {
  /* Given */
  answerUnsure(fakeRoute(home), home, 'Fix the flaky upload test.');
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

// ── The session it starts ──

test('a sure answer starts the session in the main window, which is never brought forward', async ({ app, page, home }) => {
  /* Given */
  const route = fakeRoute(home);
  answerSure(route, home, ' Fix the flaky upload test. \n', 100);
  const before = launchedKeys(home);
  await watchMainWindowFocus(app);
  const popUp = await open(app);
  await box(popUp).fill(TEXT);

  /* When */
  await box(popUp).press('Enter');

  /* Then */
  await expect(line(popUp)).toHaveText('Started in acme-api');
  expect(await quickAskShowing(app)).toBe(true);
  const launch = await (await waitForNewLaunch(home, 'claude', before)).launched();
  expect(launch.cwd).toBe(home.projectPath(P.acmeApi));
  expect(launch.argv.at(-1)).toBe('Fix the flaky upload test.');
  await expect(sessionRow(page, 'New session')).toBeVisible();
  await expect.poll(() => quickAskShowing(app)).toBe(false);
  expect(await mainWindowFocusCalls(app)).toEqual([]);
  expect(await mainWindowFocused(app)).toBe(false);

  // The pop-up warmed a process as it showed, and Quick Ask's own call went through it.
  const [call] = route.calls();
  expect(call.warm).toBe(true);
  expect(call.argv.join(' ')).toContain('Choosing kind:');
  expect(call.prompt).toContain(TEXT);

  /* When */
  await open(app);

  /* Then */
  await expect(box(popUp)).toHaveValue('');
  await expect(line(popUp)).toBeHidden();
});

test('an unsure answer lists three; ↑↓ move, and Enter starts the one picked on the rewritten prompt', async ({ app, home }) => {
  /* Given */
  answerUnsure(fakeRoute(home), home, 'Fix the flaky upload test.', 100);
  const before = launchedKeys(home);
  const popUp = await open(app);
  await box(popUp).fill(TEXT);

  /* When */
  await box(popUp).press('Enter');

  /* Then */
  await expect(choices(popUp).getByRole('option')).toHaveCount(3);
  await expect(choices(popUp).getByRole('option', { selected: true })).toHaveText('acme-api');

  /* When */
  await box(popUp).press('ArrowDown');
  await box(popUp).press('ArrowDown');
  await box(popUp).press('ArrowUp');

  /* Then */
  await expect(choices(popUp).getByRole('option', { selected: true })).toHaveText('web-dashboard');

  /* When */
  await box(popUp).press('Enter');

  /* Then */
  await expect(line(popUp)).toHaveText('Started in web-dashboard');
  const launch = await (await waitForNewLaunch(home, 'claude', before)).launched();
  expect(launch.cwd).toBe(home.projectPath(P.webDashboard));
  expect(launch.argv.at(-1)).toBe('Fix the flaky upload test.');
  await expect.poll(() => quickAskShowing(app)).toBe(false);
});

test('Tab from the list opens the picker in the main window with the rewritten prompt', async ({ app, page, home }) => {
  /* Given */
  answerUnsure(fakeRoute(home), home, 'Fix the flaky upload test.');
  const popUp = await open(app);
  await box(popUp).fill(TEXT);
  await box(popUp).press('Enter');
  await expect(choices(popUp)).toBeVisible();

  /* When */
  await box(popUp).press('Tab');

  /* Then */
  const picker = dialog(page, 'New Session');
  await expect(picker).toBeVisible();
  await expect(picker).toContainText('Fix the flaky upload test.');
  await expect.poll(() => quickAskShowing(app)).toBe(false);
});

test('no match without a quick folder hands the text to the picker, with Patch’s line, and keeps the draft', async ({ app, page, home }) => {
  /* Given */
  answerNoMatch(fakeRoute(home));
  const before = launchedKeys(home);
  const popUp = await open(app);
  await box(popUp).fill(TEXT);

  /* When */
  await box(popUp).press('Enter');

  /* Then */
  const picker = dialog(page, 'New Session');
  await expect(picker).toBeVisible();
  await expect(picker).toContainText(TEXT);
  await expect(says(page, NO_MATCH_LINE)).toBeVisible();
  await expect.poll(() => quickAskShowing(app)).toBe(false);

  /* When */
  await picker.getByText(P.acmeApi, { exact: true }).click();

  /* Then */
  const launch = await (await waitForNewLaunch(home, 'claude', before)).launched();
  expect(launch.argv.at(-1)).toBe(TEXT);
  await open(app);
  await expect(box(popUp)).toHaveValue(TEXT);
});

test('no match with a quick folder starts a quick session on the text exactly as typed', async ({ app, page, home }) => {
  /* Given */
  const quickFolder = home.projectPath(P.notes);
  await setQuickSessionFolder(page, quickFolder);
  answerNoMatch(fakeRoute(home));
  const before = launchedKeys(home);
  const popUp = await open(app);
  await box(popUp).fill(TEXT);

  /* When */
  await box(popUp).press('Enter');

  /* Then */
  await expect(line(popUp)).toHaveText('Started in notes');
  const launch = await (await waitForNewLaunch(home, 'claude', before)).launched();
  expect(launch.cwd).toBe(quickFolder);
  expect(launch.argv.at(-1)).toBe(TEXT);
  await expect(dialog(page, 'New Session')).toBeHidden();
});

test('with the main window closed, it opens without the focus and the session starts in it', async ({ app, home }) => {
  /* Given */
  answerSure(fakeRoute(home), home, 'Fix the flaky upload test.');
  const before = launchedKeys(home);
  await closeMainWindow(app);
  await expect.poll(() => app.windows().some(page => page.url().endsWith('/renderer/index.html'))).toBe(false);
  const popUp = await open(app);
  await box(popUp).fill(TEXT);

  /* When */
  await box(popUp).press('Enter');

  /* Then */
  await expect(line(popUp)).toHaveText('Started in acme-api');
  const reopened = await mainWindow(app);
  const launch = await (await waitForNewLaunch(home, 'claude', before)).launched();
  expect(launch.cwd).toBe(home.projectPath(P.acmeApi));
  expect(launch.argv.at(-1)).toBe('Fix the flaky upload test.');
  await expect(sessionRow(reopened, 'New session')).toBeVisible();
  expect(await mainWindowFocused(app)).toBe(false);
});

forEachAppearance(() => {
  test('each state of the pop-up', async ({ app, home }) => {
    /* Given */
    answerUnsure(fakeRoute(home), home, 'Fix the flaky upload test.', 1_500);
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
    await expect(line(popUp)).toHaveText('Started in acme-api');
    await expectPopUp(popUp, 'quick-ask-started');
  });
});
