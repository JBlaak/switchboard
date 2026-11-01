/**
 * BlaakTasks wired into the app (#248): a session started from a task is
 * linked to it, and the task is set In progress.
 *
 * The rules and the services are unit tested (test/tasks-service.test.ts,
 * test/tasks-handlers.test.ts, test/start-task-session.test.ts). This walks
 * the wired app across IPC: main prepares a real worktree in a real git
 * repository, the fake `claude` starts there on BlaakTasks' handoff, and once
 * it has started the link is stored, pushed to the renderer, and written to a
 * stand-in BlaakTasks: a local HTTP server speaking MCP, found through
 * `~/.claude.json` as the real one is. No real BlaakTasks is ever reached.
 *
 * The first test takes the steps the start helper takes
 * (`startTaskSessionWith`) through `window.api`; the Tasks page (#249) drives
 * the same start from the UI: switched on in Settings, opened with ⌘T, and
 * S on the task's row. The page's views, keys and routing outcomes are unit
 * tested (test/tasks-slice.test.ts, test/tasks-page-actions.test.ts).
 * The project page's Tasks section (#251) lists the task linked to its repo,
 * and S there starts it in that repo, with no routing, keeping the page. What
 * it lists and its keys are unit tested (test/project-page-tasks.test.ts).
 * A linked session's chip, Task tab and sidebar marker (#250) are walked
 * through the UI at the end.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test, expect } from '../support/test';
import { FakeCli } from '../support/fake-cli';
import { LABEL, P, S } from '../fixtures/standard';
import { openSession, sidebar } from '../support/app';
import { sessionWorkStub } from '../fixtures/session-work';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';

const TASK = '1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9';
const TITLE = 'Fix the flaky upload test';
/** A stand-in: no real server is ever reached. */
const TOKEN = 'e2e-stand-in-token';

interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
  authorization: string | undefined;
}

/** A stand-in BlaakTasks on loopback: records each `tools/call` and answers with the task (with `task`'s fields over it). */
async function fakeBlaakTasks(task: Record<string, unknown> = {}): Promise<{ url: string; calls: ToolCall[]; close(): Promise<void> }> {
  const calls: ToolCall[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const request = JSON.parse(body) as { id: number; params: { name: string; arguments: Record<string, unknown> } };
      calls.push({ tool: request.params.name, args: request.params.arguments, authorization: req.headers.authorization });
      const answer = {
        id: TASK, title: TITLE, status: 'In progress', today: true, pullRequests: [], brief: '', progress: [], url: 'https://www.notion.so/x', ...task,
      };
      const value = request.params.name === 'list' ? [answer] : answer;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(value) }] } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** BlaakTasks switched on the way a user does it: its URL saved in Settings. */
async function switchBlaakTasksOn(page: Page, url: string): Promise<void> {
  await page.getByRole('button', { name: 'Global settings', exact: true }).click();
  await page.getByText('Tasks URL', { exact: true }).locator('xpath=ancestor::*[.//input][1]').getByRole('textbox').fill(url);
  await page.getByRole('button', { name: 'Save Settings' }).click();
  await expect(page.getByText('Global Settings', { exact: true })).toBeHidden();
}

/** Make the project a git repository with one commit on `main`, as a real one would be. */
function makeRepository(dir: string): void {
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.com', ...args], { cwd: dir, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  };
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), '# acme-api\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'Initial commit');
}

test('a session started from a task is linked to it, and the task is set In progress', async ({ page, home }) => {
  /* Given: BlaakTasks set up in Claude Code and switched on in Settings, and a repository to start in */
  const blaakTasks = await fakeBlaakTasks();
  try {
    fs.writeFileSync(path.join(home.home, '.claude.json'), JSON.stringify({
      mcpServers: { blaaktasks: { type: 'http', url: blaakTasks.url, headers: { Authorization: `Bearer ${TOKEN}` } } },
    }));
    const projectPath = home.projectPath(P.acmeApi);
    makeRepository(projectPath);
    await page.evaluate(async (url) => {
      const global = await window.api.getSetting<Record<string, unknown>>('global');
      await window.api.setSetting('global', { ...global, blaakTasksUrl: url });
      const seen: [string, string | null][] = [];
      (window as unknown as { __sessionTasks: typeof seen }).__sessionTasks = seen;
      window.api.onSessionTaskChanged((sessionId, taskId) => seen.push([sessionId, taskId]));
    }, blaakTasks.url);

    /* When: started from the task, as the start helper does it */
    const started = await page.evaluate(async ({ task, title, projectPath }) => {
      const prepared = await window.api.prepareTaskStart({ task: { id: task, title }, projectPath });
      if (prepared.kind !== 'ready') return { prepared, sessionId: null };
      const sessionId = crypto.randomUUID();
      const opened = await window.api.openTerminal(sessionId, prepared.worktreePath, true, { initialPrompt: prepared.prompt });
      if (!opened.ok) return { prepared, sessionId: null };
      await window.api.taskSessionStarted(task, sessionId, prepared.projectPath);
      return { prepared, sessionId };
    }, { task: TASK, title: TITLE, projectPath });

    /* Then: Claude started in the task's worktree, on BlaakTasks' handoff */
    expect(started.prepared).toMatchObject({ kind: 'ready', projectPath, branch: 'fix-the-flaky-upload-test' });
    expect(started.sessionId).not.toBeNull();
    const sessionId = started.sessionId!;
    const launch = await new FakeCli(home.controlDir, sessionId).launched();
    expect(fs.realpathSync(launch.cwd)).toBe(fs.realpathSync(path.join(projectPath, '.claude/worktrees/fix-the-flaky-upload-test')));
    expect(launch.argv.join(' ')).toContain(`(blaaktasks ${TASK})`);

    /* Then: the session shows its link, pushed and asked for */
    await expect.poll(() => page.evaluate(() => (window as unknown as { __sessionTasks: unknown[] }).__sessionTasks))
      .toEqual([[sessionId, TASK]]);
    expect(await page.evaluate((id) => window.api.sessionTask(id), sessionId)).toBe(TASK);
    expect(await page.evaluate((task) => window.api.taskSessions(task), TASK)).toEqual({ sessions: [sessionId], owner: sessionId });
    expect(await page.evaluate((path) => window.api.projectTasks(path), projectPath)).toEqual([TASK]);

    /* Then: the task was set In progress and ★, with the token from `~/.claude.json` */
    await expect.poll(() => blaakTasks.calls.filter((call) => call.tool === 'update'))
      .toEqual([{ tool: 'update', args: { status: 'In progress', today: true, id: TASK }, authorization: `Bearer ${TOKEN}` }]);
  } finally {
    await blaakTasks.close();
  }
});

test('with no BlaakTasks URL set, nothing is started and nothing is linked', async ({ page }) => {
  /* When */
  const answers = await page.evaluate(async (task) => ({
    prepared: await window.api.prepareTaskStart({ task: { id: task, title: 'Anything' } }),
    listed: await window.api.listTasks({ view: 'today' }),
    linked: await window.api.sessionTasks(),
  }), TASK);

  /* Then */
  expect(answers).toEqual({ prepared: { kind: 'off' }, listed: { kind: 'off' }, linked: {} });
});

test('the Tasks page opens with ⌘T once BlaakTasks is on, and S starts a session on the task without leaving it', async ({ page, home }) => {
  /* Given: BlaakTasks set up in Claude Code, a repository the task is linked to, and no Tasks page yet */
  const blaakTasks = await fakeBlaakTasks();
  try {
    fs.writeFileSync(path.join(home.home, '.claude.json'), JSON.stringify({
      mcpServers: { blaaktasks: { type: 'http', url: blaakTasks.url, headers: { Authorization: `Bearer ${TOKEN}` } } },
    }));
    const projectPath = home.projectPath(P.acmeApi);
    makeRepository(projectPath);
    const tasksPage = page.getByRole('region', { name: 'Tasks' });
    await expect(page.getByRole('button', { name: 'Tasks', exact: true })).toHaveCount(0);

    /* When: the URL is saved in Settings */
    await switchBlaakTasksOn(page, blaakTasks.url);
    await page.evaluate(({ task, projectPath }) => window.api.setTaskRepo(task, projectPath), { task: TASK, projectPath });

    /* Then: the page has its entry point, and ⌘T opens it on ★ Today with the task's row */
    await expect(page.getByRole('button', { name: 'Tasks', exact: true })).toBeVisible();
    await page.keyboard.press('Meta+t');
    await expect(tasksPage).toBeFocused();
    await expect(tasksPage.getByRole('tab', { name: '★ Today' })).toHaveAttribute('aria-selected', 'true');
    await expect(tasksPage.getByRole('radio', { name: 'Work' })).toHaveAttribute('aria-checked', 'true');
    const row = tasksPage.locator(`[data-task-id="${TASK}"]`);
    await expect(row).toContainText(TITLE);
    await expect(row).toContainText('In progress');
    await expect(row).toHaveAttribute('aria-selected', 'true');

    /* When: one click on the row */
    await row.click();

    /* Then: its detail opens */
    await expect(tasksPage.getByRole('complementary', { name: 'Task detail' })).toContainText(TITLE);

    /* When: S on the row under the cursor, and extra instructions for it */
    await page.keyboard.press('s');
    await expect(tasksPage.getByRole('textbox', { name: 'Extra instructions' })).toBeFocused();
    await page.keyboard.type('Only the upload test.');
    await page.keyboard.press('Enter');

    /* Then: Claude started in the task's worktree with them, the page kept the main area, and the session has a sidebar row */
    await expect(row.getByRole('status')).toContainText('Started in');
    let owner: string | null = null;
    await expect.poll(async () => (owner = (await page.evaluate((task) => window.api.taskSessions(task), TASK)).owner)).not.toBeNull();
    const launch = await new FakeCli(home.controlDir, owner!).launched();
    expect(fs.realpathSync(launch.cwd)).toBe(fs.realpathSync(path.join(projectPath, '.claude/worktrees/fix-the-flaky-upload-test')));
    expect(launch.argv.at(-1)).toMatch(/\n\nExtra instructions: Only the upload test\.$/);
    await expect(sidebar(page).locator(`[data-session-id="${owner}"]`)).toBeVisible();
    await expect(tasksPage).toBeVisible();
    await expect.poll(() => blaakTasks.calls.some((call) => call.tool === 'update' && call.args.id === TASK)).toBe(true);

    /* When: Esc, for the start's answer, the detail and the page */
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    /* Then */
    await expect(tasksPage).toHaveCount(0);
  } finally {
    await blaakTasks.close();
  }
});

test('the project page lists the repo’s linked task, and S starts it in this repo without leaving the page', async ({ page, home }) => {
  /* Given: BlaakTasks on, and the task linked to the repository */
  const blaakTasks = await fakeBlaakTasks();
  try {
    fs.writeFileSync(path.join(home.home, '.claude.json'), JSON.stringify({
      mcpServers: { blaaktasks: { type: 'http', url: blaakTasks.url, headers: { Authorization: `Bearer ${TOKEN}` } } },
    }));
    const projectPath = home.projectPath(P.acmeApi);
    makeRepository(projectPath);
    await switchBlaakTasksOn(page, blaakTasks.url);
    await page.evaluate(({ task, projectPath }) => window.api.setTaskRepo(task, projectPath), { task: TASK, projectPath });

    /* When: the project's page opens */
    await sidebar(page).locator(`[data-session-id="${S.loginFix}"]`).getByTestId('project-link').click();

    /* Then: its Tasks section lists the task */
    const projectPage = page.getByRole('region', { name: /^Project / });
    const section = projectPage.getByRole('region', { name: 'Tasks' });
    const row = section.locator(`[data-task-id="${TASK}"]`);
    await expect(row).toContainText(TITLE);
    await expect(row).toContainText('In progress');
    expect(blaakTasks.calls.filter((call) => call.tool === 'get').map((call) => call.args.task)).toContain(TASK);

    /* When: S on the task's row */
    await row.click();
    await expect(row).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('s');

    /* Then: Claude started in the task's worktree in this repo, and the page kept the main area */
    await expect(row.getByRole('status')).toContainText('Started in');
    let owner: string | null = null;
    await expect.poll(async () => (owner = (await page.evaluate((task) => window.api.taskSessions(task), TASK)).owner)).not.toBeNull();
    const launch = await new FakeCli(home.controlDir, owner!).launched();
    expect(fs.realpathSync(launch.cwd)).toBe(fs.realpathSync(path.join(projectPath, '.claude/worktrees/fix-the-flaky-upload-test')));
    await expect(sidebar(page).locator(`[data-session-id="${owner}"]`)).toBeVisible();
    await expect(projectPage).toBeVisible();
  } finally {
    await blaakTasks.close();
  }
});

test.describe('the task on its session', () => {
  test.use({ stubs: { sessionWork: sessionWorkStub() } });

  test('a linked session shows its task: the chip, the Task tab and the sidebar marker', async ({ page, home }) => {
    /* Given: BlaakTasks on, and a session on screen with no task */
    const blaakTasks = await fakeBlaakTasks({
      brief: 'The login page loops back to itself after the cookie expires.',
      progress: [
        { day: '2026-10-27', text: 'Claude started work' },
        { day: '2026-10-28', text: 'Found the cause: the cookie path' },
      ],
      pullRequests: ['https://github.com/acme/api/pull/1320'],
    });
    try {
      fs.writeFileSync(path.join(home.home, '.claude.json'), JSON.stringify({
        mcpServers: { blaaktasks: { type: 'http', url: blaakTasks.url, headers: { Authorization: `Bearer ${TOKEN}` } } },
      }));
      await switchBlaakTasksOn(page, blaakTasks.url);
      await openSession(page, home, LABEL.loginFix, S.loginFix);
      const chip = page.locator('#terminal-header-task');
      const marker = page.locator(`[data-session-id="${S.loginFix}"]`).getByTestId('session-task-marker');
      await expect(chip).toHaveCount(0);
      await expect(marker).toHaveCount(0);

      /* When: the session is linked to the task */
      await page.evaluate(({ sessionId, task }) => window.api.linkSessionTask(sessionId, task), { sessionId: S.loginFix, task: TASK });

      /* Then: the chip names the task and its status, and the row is marked */
      await expect(chip).toContainText(TITLE);
      await expect(chip).toContainText('In progress');
      await expect(marker).toHaveAttribute('title', 'Task: ' + TITLE);

      /* When: the chip is clicked */
      await chip.click();

      /* Then: Session work opens on the Task tab, oldest progress first, with the PR's state */
      const work = page.getByRole('region', { name: /^Session work for / });
      await expect(work.getByRole('tab', { name: 'Task' })).toHaveAttribute('aria-selected', 'true');
      const tab = work.getByTestId('session-task-tab');
      await expect(tab.getByRole('heading', { name: TITLE })).toBeVisible();
      await expect(tab).toContainText('The login page loops back to itself after the cookie expires.');
      await expect(tab.locator('.st-log li')).toHaveText([/Claude started work/, /Found the cause: the cookie path/]);
      await expect(tab.getByRole('button', { name: '#1320 open' })).toBeVisible();
      for (const name of ['Mark done', 'Snooze', 'Open in Notion']) await expect(tab.getByRole('button', { name })).toBeVisible();

      /* When: unlinked */
      await page.evaluate((sessionId) => window.api.unlinkSessionTask(sessionId), S.loginFix);

      /* Then: the tab and the marker go */
      await expect(work.getByRole('tab', { name: 'Task' })).toHaveCount(0);
      await expect(marker).toHaveCount(0);
    } finally {
      await blaakTasks.close();
    }
  });
});
