/**
 * Asking Patch to start a session from the empty screen (#135).
 *
 * The routing rules (the candidates, the call, reading the answer) and the
 * box's state are unit tested (test/ask-route*.test.ts, test/ask-slice.test.ts,
 * test/ask-keys.test.ts). These walk the wired app: the text crosses IPC, main
 * sends it to the fake `claude -p` the box warmed on focus, and the answer
 * starts a session, offers the choices, or hands the text to the picker.
 */
import { test, expect } from '../support/test';
import { dialog } from '../support/app';
import { fakeRoute, launchedKeys, waitForNewLaunch } from '../support/fake-cli';
import { P } from '../fixtures/standard';
import type { Page } from '@playwright/test';

const box = (page: Page) => page.getByTestId('ask-box');
const says = (page: Page, line: string | RegExp) => page.locator('#placeholder').getByText(line);

test('a confident answer starts the session in that project on the rewritten prompt', async ({ page, home }) => {
  /* Given */
  const route = fakeRoute(home);
  const acmeApi = home.projectPath(P.acmeApi);
  route.answer({ projectPath: acmeApi, confident: true, candidates: [acmeApi], prompt: ' Fix the login redirect loop. \n' });
  const before = launchedKeys(home);

  /* When */
  await expect(box(page)).toBeFocused();
  await box(page).fill('lets fix the login loop in acme-api');
  await box(page).press('Enter');

  /* Then */
  const claude = await waitForNewLaunch(home, 'claude', before);
  const launch = await claude.launched();
  expect(launch.cwd).toBe(acmeApi);
  expect(launch.argv.at(-1)).toBe('Fix the login redirect loop.');
  await expect(box(page)).toHaveValue('');

  // The box warmed a process when it got focus, and the request went through it.
  const [call] = route.calls();
  expect(call.warm).toBe(true);
  expect(call.argv).toEqual(expect.arrayContaining(['-p', '--model', 'haiku', '--input-format', 'stream-json']));
  const prompt = call.prompt;
  expect(prompt).toContain(`path: ${acmeApi}`);
  expect(prompt).toContain(`path: ${home.projectPath(P.webDashboard)}`);
  expect(prompt).not.toContain('.claude/worktrees');
  expect(prompt).toContain('lets fix the login loop in acme-api');
});

test('an unsure answer offers the candidates, and Enter starts the one picked', async ({ page, home }) => {
  /* Given */
  const route = fakeRoute(home);
  const acmeApi = home.projectPath(P.acmeApi);
  const dashboard = home.projectPath(P.webDashboard);
  route.answer({ projectPath: acmeApi, confident: false, candidates: [acmeApi, dashboard], prompt: 'Make the charts faster.' }, 500);
  const before = launchedKeys(home);

  /* When */
  await box(page).fill('make the charts faster');
  await box(page).press('Enter');

  /* Then */
  await expect(box(page)).toHaveAttribute('aria-busy', 'true');
  await expect(says(page, /think|Thinking|again…/)).toBeVisible();
  const choices = page.getByRole('listbox', { name: 'Projects' });
  await expect(choices.getByRole('option')).toHaveCount(2);
  await expect(choices.getByRole('option', { selected: true })).toContainText('acme-api');
  await expect(page.getByTestId('ask-choices')).toContainText('Make the charts faster.');

  /* When */
  await box(page).press('ArrowDown');
  await box(page).press('Enter');

  /* Then */
  const launch = await (await waitForNewLaunch(home, 'claude', before)).launched();
  expect(launch.cwd).toBe(dashboard);
  expect(launch.argv.at(-1)).toBe('Make the charts faster.');
});

test('Esc while Patch is thinking cancels, and the text can be edited again', async ({ page, home }) => {
  /* Given */
  const route = fakeRoute(home);
  const acmeApi = home.projectPath(P.acmeApi);
  route.answer({ projectPath: acmeApi, confident: true, candidates: [acmeApi], prompt: 'Too late.' }, 5_000);
  const before = launchedKeys(home);

  /* When */
  await box(page).fill('fix the login loop');
  await box(page).press('Enter');
  await expect(box(page)).toHaveAttribute('aria-busy', 'true');
  await box(page).press('Escape');

  /* Then */
  await expect(says(page, 'Okay, never mind.')).toBeVisible();
  await expect(box(page)).toHaveValue('fix the login loop');
  await expect(box(page)).toBeEditable();
  await page.waitForTimeout(5_500);
  expect([...launchedKeys(home)].filter(key => !before.has(key))).toEqual([]);
});

test('a failed call says why and opens the picker, which starts on the text as typed', async ({ page, home }) => {
  /* Given */
  const route = fakeRoute(home);
  route.fail('You’ve hit your limit · resets 3pm (UTC)');
  const before = launchedKeys(home);

  /* When */
  await box(page).fill('fix the login loop');
  await box(page).press('Enter');

  /* Then */
  await expect(says(page, 'You’ve hit your usage limit — resets 3pm (UTC).')).toBeVisible();
  const picker = dialog(page, 'New Session');
  await expect(picker).toBeVisible();
  await expect(picker).toContainText('fix the login loop');

  /* When */
  await picker.getByText(P.acmeApi, { exact: true }).click();

  /* Then */
  const launch = await (await waitForNewLaunch(home, 'claude', before)).launched();
  expect(launch.cwd).toBe(home.projectPath(P.acmeApi));
  expect(launch.argv.at(-1)).toBe('fix the login loop');
});
