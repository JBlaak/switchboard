/**
 * A running session: the fake `claude` in the terminal, and everything the app
 * reads out of its output — busy and idle, notifications, program status, the
 * title, the exit, a fork.
 */
import { test, expect, forEachAppearance } from '../support/test';
import {
  dialog, expectScreen, openSession, sessionRow, sidebar, sidebarFilter, terminalHeader, terminalStatus,
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
  await sidebarFilter(page, 'today').click();
  await sidebarFilter(page, 'today').click();
}

test.describe('smoke', () => {
  test('resumes a session with the question hook and shows its header', async ({ page, home }) => {
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    const launch = await claude.launched();
    expect(launch.resume).toBe(true);
    expect(launch.argv).toContain('--resume');
    expect(launch.settings?.hooks?.PreToolUse?.[0].matcher).toBe('AskUserQuestion');
    expect(launch.cwd).toBe(home.projectPath('Development/acme-api'));
    await expect(terminalHeader(page).getByText(LABEL.loginFix, { exact: true })).toBeVisible();
    await expect(terminalHeader(page).getByText(S.loginFix, { exact: true })).toBeVisible();
  });

  test('typing in the terminal reaches the process', async ({ page, home }) => {
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    await page.keyboard.type('hello');
    await claude.waitForInput('hello');
  });

  test('OSC 0 titles set the header and drive working/ready', async ({ page, home }) => {
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    await claude.busy('Reading the redirect handler');
    await expect(sidebar(page).getByText('Working', { exact: true })).toBeVisible();
    await expect(terminalHeader(page).getByText('⠋ Reading the redirect handler')).toBeVisible();

    await claude.idle('Claude Code');
    await expect(sidebar(page).getByText('Ready', { exact: true })).toBeVisible();
  });

  test('OSC 7501 program status overrides titles', async ({ page, home }) => {
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    await claude.status({ state: 'working' });
    await expect(sidebar(page).getByText('Working', { exact: true })).toBeVisible();
    // Once 7501 is spoken, an idle title no longer ends the turn.
    await claude.idle();
    await expect(sidebar(page).getByText('Working', { exact: true })).toBeVisible();
    // A session on screen is never flagged (the user is looking at it).
    await sessionRow(page, LABEL.chartsDarkMode).click();
    await claude.status({ state: 'blocked', kind: 'permission', msg: 'Allow Bash(npm test)?' });
    await redrawSidebar(page);
    await expect(sidebar(page).getByText('Needs input', { exact: true })).toBeVisible();
  });

  test('an OSC 9 notification asks for the user', async ({ page, home }) => {
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    await claude.status({ state: 'working' });
    // Look at another session, so the notification is for one not on screen.
    await sessionRow(page, LABEL.chartsDarkMode).click();
    await claude.notify('Claude needs your permission to use Bash');
    await claude.notify777('Claude Code', 'Claude needs your permission to use Bash');
    await redrawSidebar(page);
    await expect(sidebar(page).getByText('Needs input', { exact: true })).toBeVisible();
  });

  test('the exit code ends the session', async ({ page, home }) => {
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    await claude.exit(3);
    await expect(terminalStatus(page)).toHaveText('Stopped');
  });

  test('a fork re-keys the running session', async ({ page, home }) => {
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    const forkId = sessionId('login-fix-fork');
    await claude.fork(forkId, 'Forked: try a different redirect strategy');
    await expect(terminalHeader(page).getByText(forkId, { exact: true })).toBeVisible();
  });

  test('a new session from the picker launches with a fresh id', async ({ page, home }) => {
    const before = launchedKeys(home);
    await page.getByRole('button', { name: 'New session', exact: true }).click();
    await dialog(page, 'New Session').getByText('Development/web-dashboard', { exact: true }).click();
    const claude = await waitForNewLaunch(home, 'claude', before);
    const launch = await claude.launched();
    expect(launch.resume).toBe(false);
    expect(launch.argv).toContain('--session-id');
    expect(launch.cwd).toBe(home.projectPath('Development/web-dashboard'));

    // The CLI's first transcript write is what makes the session a real row.
    await claude.userTurn('Make the export button work offline');
    await expect(sessionRow(page, 'Make the export button work offline')).toBeVisible();
  });
});

forEachAppearance(() => {
  test('terminal with header, running', async ({ page, home }) => {
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    await claude.busy('Reading the redirect handler');
    await claude.println(
      '',
      '\x1b[1m● Read\x1b[0m(src/auth/redirect.ts)',
      '  ⎿  Read 84 lines',
      '',
      '\x1b[32m●\x1b[0m The redirect loop comes from the session cookie being set',
      '  on the wrong path, so every request looks unauthenticated.',
    );
    await expect(sidebar(page).getByText('Working', { exact: true })).toBeVisible();
    await expectScreen(page, 'terminal-running');
  });
});
