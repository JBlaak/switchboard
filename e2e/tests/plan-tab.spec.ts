/**
 * The Plan tab (#124) wired into the real app: the Session work page's tabs,
 * the plan from a stubbed back end drawn as a diagram, and an issue's detail.
 *
 * Levels, states, warnings, geometry and the slice are unit tested in
 * test/plan-*.test.ts; this proves the wiring: the tab asks main for the
 * session's plans and shows them, a click opens an issue, a level that
 * clears between two polls celebrates once, Start level starts one
 * session that coordinates an agent per Ready issue, and a start refused
 * over an existing branch offers to continue on it, open its session, or
 * delete it and start again.
 */
import { test, expect } from '../support/test';
import { openSession, terminalHeader } from '../support/app';
import { existingBranchAsks, openedExternally, setHostStub } from '../support/main-process';
import { LABEL, P, S } from '../fixtures/standard';
import { sessionWorkStub } from '../fixtures/session-work';
import { LOGIN_PLAN, LOGIN_PLAN_ON_LEVEL_3, plansStub } from '../fixtures/plans';
import { FakeCli } from '../support/fake-cli';
import fs from 'node:fs';
import type { Page } from '@playwright/test';

function workPage(page: Page) {
  return page.getByRole('region', { name: /^Session work for / });
}

function diagram(page: Page) {
  return page.getByTestId('plan-diagram');
}

function node(page: Page, number: number) {
  return diagram(page).getByRole('button', { name: new RegExp(`^#${number} `) });
}

function detail(page: Page) {
  return page.getByRole('complementary', { name: 'Issue detail' });
}

test.use({ stubs: { sessionWork: sessionWorkStub(), plans: plansStub() } });

test('the Plan tab shows the session’s plan, and a click opens an issue’s detail', async ({ page, home, app }) => {
  /* Given */
  await openSession(page, home, LABEL.loginFix, S.loginFix);
  await page.keyboard.press('Meta+g');
  await expect(workPage(page).getByRole('heading', { level: 1 })).toHaveText('Work · ' + LABEL.loginFix);

  /* When */
  await workPage(page).getByRole('tab', { name: 'Plan' }).click();

  /* Then */
  await expect(workPage(page).getByRole('tab', { name: 'Plan' })).toHaveAttribute('aria-selected', 'true');
  await expect(workPage(page).getByRole('heading', { name: 'Login rework' })).toBeVisible();
  await expect(workPage(page).getByText('Level 2 of 3')).toBeVisible();
  for (const number of [1301, 1302, 1303, 1304, 1305]) await expect(node(page, number)).toBeVisible();
  await expect(node(page, 1302)).toContainText('Session ' + LABEL.loginFix);
  await expect(diagram(page).getByLabel('Level 2, You are here')).toBeVisible();

  /* When */
  await node(page, 1302).click();

  /* Then */
  await expect(detail(page).getByRole('heading', { name: 'Stop the login redirect loop' })).toBeVisible();
  await expect(detail(page)).toContainText('1 of 2 ticked on GitHub');
  await expect(detail(page).getByRole('button', { name: /^#1301 / })).toBeVisible();
  await expect(detail(page).getByRole('button', { name: /^#1304 / })).toBeVisible();

  /* When */
  await page.keyboard.press('ArrowDown');

  /* Then */
  await expect(detail(page).getByRole('heading', { name: 'Remember me for 30 days' })).toBeVisible();

  /* When */
  await detail(page).getByRole('button', { name: 'Open issue' }).click();

  /* Then */
  await expect.poll(() => openedExternally(app)).toContain('https://github.com/acme/api/issues/1303');

  /* When */
  await page.keyboard.press('Escape');

  /* Then */
  await expect(detail(page)).toHaveCount(0);
  await expect(workPage(page)).toBeVisible();

  /* When */
  await workPage(page).getByRole('button', { name: /^#22 / }).click();

  /* Then */
  await expect(node(page, 48)).toBeAttached();
});

/** `PLAN_POLL_MS` in `plan/install-plan`: how often an open plan view asks again (W4). */
const PLAN_POLL_MS = 60_000;

test.describe('level up', () => {
  test.use({ fakeTimers: true });

  test('a level that clears between two polls celebrates once', async ({ page, home, app }) => {
    /* Given: the plan is seen on level 2 for the first time, which does not celebrate */
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await page.keyboard.press('Meta+g');
    await workPage(page).getByRole('tab', { name: 'Plan' }).click();
    await expect(workPage(page).getByText('Level 2 of 3')).toBeVisible();
    const cheer = page.getByRole('status').filter({ hasText: 'Level up!' });
    await expect(cheer).toHaveCount(0);

    /* When: level 2 clears before the next poll */
    await setHostStub(app, 'plans', plansStub(LOGIN_PLAN_ON_LEVEL_3));
    await page.clock.fastForward(PLAN_POLL_MS);

    /* Then: Patch's line, alone under the e2e's reduced motion */
    await expect(workPage(page).getByText('Level 3 of 3')).toBeVisible();
    await expect(cheer).toHaveText('Level up! Last level: 3 of 3.');
    await expect(diagram(page).getByLabel('Level 3, You are here')).toBeVisible();

    /* When: the next poll finds the same level */
    await page.clock.fastForward(PLAN_POLL_MS);

    /* Then */
    await expect(cheer).toHaveCount(0);
    await expect(workPage(page).getByText('Level 3 of 3')).toBeVisible();
  });
});

test.describe('start level', () => {
  /** The login plan with #1302's PR gone: #1302 and #1303 both Ready on level 2. */
  const twoReady = { ...LOGIN_PLAN, issues: LOGIN_PLAN.issues.map(i => (i.number === 1302 ? { ...i, pullRequests: [] } : i)) };
  test.use({ stubs: { sessionWork: sessionWorkStub(), plans: { ...plansStub(twoReady), prepareWorktrees: true } } });

  test('Start level starts one session with an agent per Ready issue, coordinated from it', async ({ page, home }) => {
    /* Given */
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await page.keyboard.press('Meta+g');
    await workPage(page).getByRole('tab', { name: 'Plan' }).click();
    const before = fs.readdirSync(home.controlDir);

    /* When */
    await diagram(page).getByRole('button', { name: 'Start level' }).click();

    /* Then */
    const confirm = workPage(page).getByRole('group', { name: 'Start level' });
    await expect(confirm).toContainText('Start a session with 2 agents?');
    await expect(confirm).toContainText('#1302, #1303');

    /* When */
    await confirm.getByRole('button', { name: 'Start session' }).click();

    /* Then */
    await expect(workPage(page).getByText('Started a session with 2 agents.')).toBeVisible();
    const startedSince = () => fs.readdirSync(home.controlDir).filter(key => !before.includes(key));
    await expect.poll(startedSince).toHaveLength(1);
    const started = startedSince();
    const launch = await new FakeCli(home.controlDir, started[0]).launched();
    const project = launch.cwd;
    expect(launch.argv).toContain('--add-dir');
    expect(launch.argv).toContain(project + '/.claude/worktrees/1302-issue');
    expect(launch.argv).toContain(project + '/.claude/worktrees/1303-issue');
    const prompt = launch.argv[launch.argv.length - 1];
    expect(prompt).toContain('You coordinate level 2 of #1300: 2 issues');
    expect(prompt).toContain('one agent per issue with the Agent tool');
    expect(prompt).toContain('- #1302: worktree ' + project + '/.claude/worktrees/1302-issue (branch 1302-issue). Work on #1302.');
    expect(prompt).toContain('- #1303: worktree ' + project + '/.claude/worktrees/1303-issue (branch 1303-issue). Work on #1303.');
  });
});

test.describe('an existing branch', () => {
  /** The login plan with #1302's PR gone: #1303 is Ready, and its branch exists from an archived session. */
  const twoReady = { ...LOGIN_PLAN, issues: LOGIN_PLAN.issues.map(i => (i.number === 1302 ? { ...i, pullRequests: [] } : i)) };
  test.use({
    stubs: {
      sessionWork: sessionWorkStub(),
      plans: { ...plansStub(twoReady), prepareWorktrees: true, existingBranches: { issues: [1303], session: S.graphqlSpike } },
    },
  });

  async function startOn1303(page: Page, home: Parameters<typeof openSession>[1]) {
    // The stub makes no worktree on disk, and a session only starts in a directory that exists.
    fs.mkdirSync(home.projectPath(P.acmeApi + '/.claude/worktrees/1303-issue'), { recursive: true });
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await page.keyboard.press('Meta+g');
    await workPage(page).getByRole('tab', { name: 'Plan' }).click();
    await node(page, 1303).click();
    await detail(page).getByRole('button', { name: 'Start session on #1303' }).click();
    return detail(page).getByRole('alert', { name: 'Branch exists' });
  }

  function startedSince(home: { controlDir: string }, before: string[]) {
    return fs.readdirSync(home.controlDir).filter(key => !before.includes(key));
  }

  test('Continue work starts a session in its worktree, told to pick up the work', async ({ page, home, app }) => {
    /* Given */
    const refused = await startOn1303(page, home);
    const before = fs.readdirSync(home.controlDir);
    await expect(refused).toContainText('in a worktree with 2 uncommitted files and 1 commit not on the default branch');

    /* When */
    await refused.getByRole('button', { name: 'Continue work' }).click();

    /* Then */
    await expect.poll(() => startedSince(home, before)).toHaveLength(1);
    const launch = await new FakeCli(home.controlDir, startedSince(home, before)[0]).launched();
    expect(launch.cwd).toMatch(/\/\.claude\/worktrees\/1303-issue$/);
    expect(launch.argv[launch.argv.length - 1]).toBe('Continue work on #1303.');
    expect(await existingBranchAsks(app)).toEqual([null, 'reuse']);
  });

  test('Delete asks once more, then starts afresh', async ({ page, home, app }) => {
    /* Given */
    const refused = await startOn1303(page, home);
    const before = fs.readdirSync(home.controlDir);

    /* When */
    await refused.getByRole('button', { name: 'Delete worktree and branch…' }).click();

    /* Then */
    const confirm = detail(page).getByRole('alertdialog', { name: 'Delete worktree and branch' });
    await expect(confirm).toContainText('Delete its worktree and branch, with 2 uncommitted files and 1 commit not on the default branch?');
    expect(await existingBranchAsks(app)).toEqual([null]);

    /* When */
    await confirm.getByRole('button', { name: 'Delete and start again' }).click();

    /* Then */
    await expect.poll(() => startedSince(home, before)).toHaveLength(1);
    const launch = await new FakeCli(home.controlDir, startedSince(home, before)[0]).launched();
    expect(launch.argv[launch.argv.length - 1]).toBe('Work on #1303.');
    expect(await existingBranchAsks(app)).toEqual([null, 'replace']);
  });

  test('Open its session puts the session that worked on it on screen, archived or not', async ({ page, home }) => {
    /* Given */
    const refused = await startOn1303(page, home);

    /* When */
    await refused.getByRole('button', { name: 'Open its session' }).click();

    /* Then */
    await new FakeCli(home.controlDir, S.graphqlSpike).launched();
    await expect(terminalHeader(page)).toContainText(LABEL.graphqlSpike);
  });
});
