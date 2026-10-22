/**
 * A running session: the fake `claude` in the terminal, and everything the app
 * reads out of its output — busy and idle, notifications, program status, the
 * title, a fork. Typing and the exit are covered with the terminal host, in
 * terminal-host.spec.ts.
 */
import { test, expect, forEachAppearance } from '../support/test';
import {
  dialog, expectScreen, openSession, sessionRow, sidebar, sidebarFilter, terminalHeader,
} from '../support/app';
import type { Page } from '@playwright/test';
import { launchedKeys, waitForNewLaunch } from '../support/fake-cli';
import { sessionId } from '../support/fixture-home';
import { LABEL, S } from '../fixtures/standard';

/**
 * Flagging a session for attention marks its row in place; it moves to the
 * "Needs input" section on the next redraw, which toggling a filter forces.
 */
async function redrawSidebar(page: Page): Promise<void> {
  await sidebarFilter(page, 'pinned').click();
  await sidebarFilter(page, 'pinned').click();
}

test.describe('smoke', () => {
  test('resumes a session with the question hook and shows its header', async ({ page, home }) => {
    /* When */
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    const launch = await claude.launched();

    /* Then */
    expect(launch.resume).toBe(true);
    expect(launch.argv).toContain('--resume');
    expect(launch.settings?.hooks?.PreToolUse?.[0].matcher).toBe('AskUserQuestion');
    expect(launch.cwd).toBe(home.projectPath('Development/acme-api'));
    await expect(terminalHeader(page).getByText(LABEL.loginFix, { exact: true })).toBeVisible();
    await expect(terminalHeader(page).getByText(S.loginFix, { exact: true })).toBeVisible();
    // The header is a window drag region whose controls opt out.
    const region = (locator: ReturnType<typeof terminalHeader>) =>
      locator.evaluate(el => getComputedStyle(el).getPropertyValue('-webkit-app-region'));
    expect(await region(terminalHeader(page))).toBe('drag');
    expect(await region(terminalHeader(page).getByRole('button', { name: 'Stop process', exact: true }))).toBe('no-drag');
    expect(await region(terminalHeader(page).getByText(LABEL.loginFix, { exact: true }))).toBe('no-drag');
    expect(await region(terminalHeader(page).getByText(S.loginFix, { exact: true }))).toBe('no-drag');
  });

  test('OSC 0 titles set the header and drive working/ready, and a notification replaces the title', async ({ page, home }) => {
    /* Given */
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);

    /* When */
    await claude.busy('Reading the redirect handler');

    /* Then */
    await expect(sidebar(page).getByText('Working', { exact: true })).toBeVisible();
    await expect(terminalHeader(page).getByText('⠋ Reading the redirect handler')).toBeVisible();

    /* When */
    await claude.idle('Claude Code');

    /* Then */
    await expect(sidebar(page).getByText('Ready', { exact: true })).toBeVisible();
    await expect(terminalHeader(page).getByText('✳ Claude Code', { exact: true })).toBeVisible();

    /* When */
    await claude.notify('Claude needs your permission to use Bash');

    /* Then */
    await expect(terminalHeader(page).getByText('Claude needs your permission to use Bash', { exact: true })).toBeVisible();
    await expect(terminalHeader(page).getByText('✳ Claude Code', { exact: true })).toHaveCount(0);
  });

  test('OSC 7501 program status overrides titles, and it or an OSC 9 notification flags a session off screen', async ({ page, home }) => {
    /* Given */
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);

    /* When */
    await claude.status({ state: 'working' });

    /* Then */
    await expect(sidebar(page).getByText('Working', { exact: true })).toBeVisible();

    /* When */
    // Once 7501 is spoken, an idle title no longer ends the turn.
    await claude.idle();

    /* Then */
    await expect(sidebar(page).getByText('Working', { exact: true })).toBeVisible();

    /* When */
    // A session on screen is never flagged (the user is looking at it).
    await sessionRow(page, LABEL.chartsDarkMode).click();
    await claude.status({ state: 'blocked', kind: 'permission', msg: 'Allow Bash(npm test)?' });
    await redrawSidebar(page);

    /* Then */
    await expect(sidebar(page).getByText('Needs input', { exact: true })).toBeVisible();

    /* When */
    // Looking at it settles the flag; a notification raises it again.
    await sessionRow(page, LABEL.loginFix).click();
    await claude.status({ state: 'working' });
    await sessionRow(page, LABEL.chartsDarkMode).click();
    await redrawSidebar(page);

    /* Then */
    await expect(sidebar(page).getByText('Needs input', { exact: true })).toHaveCount(0);

    /* When */
    await claude.notify('Claude needs your permission to use Bash');
    await claude.notify777('Claude Code', 'Claude needs your permission to use Bash');
    await redrawSidebar(page);

    /* Then */
    await expect(sidebar(page).getByText('Needs input', { exact: true })).toBeVisible();
  });

  test('a fork re-keys the running session, keeping the same row, highlighted, and the same terminal', async ({ page, home }) => {
    /* Given */
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    // Tag the live elements, so "the same row" means the same node and not
    // merely one that looks alike after a remove and re-add.
    await page.evaluate((id) => {
      const row = document.querySelector<HTMLElement>(`.session-item[data-session-id="${id}"]`)!;
      (row as HTMLElement & { e2eTag?: string }).e2eTag = 'row';
      const term = document.querySelector<HTMLElement>('.terminal-container.visible')!;
      (term as HTMLElement & { e2eTag?: string }).e2eTag = 'terminal';
    }, S.loginFix);
    const forkId = sessionId('login-fix-fork');

    /* When */
    await claude.fork(forkId, 'Forked: try a different redirect strategy');

    /* Then */
    await expect(terminalHeader(page).getByText(forkId, { exact: true })).toBeVisible();
    const after = await page.evaluate((id) => {
      const row = document.querySelector<HTMLElement>(`.session-item[data-session-id="${id}"]`);
      const term = document.querySelector<HTMLElement>('.terminal-container.visible');
      return {
        rowTag: (row as (HTMLElement & { e2eTag?: string }) | null)?.e2eTag,
        active: row?.classList.contains('active'),
        terminalTag: (term as (HTMLElement & { e2eTag?: string }) | null)?.e2eTag,
      };
    }, forkId);
    expect(after).toMatchObject({ rowTag: 'row', active: true, terminalTag: 'terminal' });
    // The fork's new turn may move the row to another section; it moves as itself.
    await expect(terminalHeader(page).getByText('Forked: try a different redirect strategy')).toBeVisible();
  });

  test('a new session from the picker launches with a fresh id', async ({ page, home }) => {
    /* Given */
    const before = launchedKeys(home);

    /* When */
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await dialog(page, 'Projects').getByText('Development/web-dashboard', { exact: true }).click();

    /* Then */
    const claude = await waitForNewLaunch(home, 'claude', before);
    const launch = await claude.launched();
    expect(launch.resume).toBe(false);
    expect(launch.argv).toContain('--session-id');
    expect(launch.cwd).toBe(home.projectPath('Development/web-dashboard'));

    /* When */
    // The CLI's first transcript write is what makes the session a real row.
    await claude.userTurn('Make the export button work offline');

    /* Then */
    await expect(sessionRow(page, 'Make the export button work offline')).toBeVisible();
  });
});

forEachAppearance(() => {
  test('terminal with header, running', async ({ page, home }) => {
    /* Given */
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);

    /* When */
    await claude.busy('Reading the redirect handler');
    await claude.println(
      '',
      '\x1b[1m● Read\x1b[0m(src/auth/redirect.ts)',
      '  ⎿  Read 84 lines',
      '',
      '\x1b[32m●\x1b[0m The redirect loop comes from the session cookie being set',
      '  on the wrong path, so every request looks unauthenticated.',
    );

    /* Then */
    await expect(sidebar(page).getByText('Working', { exact: true })).toBeVisible();
    await expectScreen(page, 'terminal-running');
  });
});
