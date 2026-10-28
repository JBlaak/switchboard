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
 * The Tasks page and the session's task chip (#249, #250) drive this from
 * the UI; until then the steps are the ones their start helper takes
 * (`startTaskSessionWith`), called through `window.api`.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test, expect } from '../support/test';
import { FakeCli } from '../support/fake-cli';
import { P } from '../fixtures/standard';
import type { AddressInfo } from 'node:net';

const TASK = '1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9';
const TITLE = 'Fix the flaky upload test';
/** A stand-in: no real server is ever reached. */
const TOKEN = 'e2e-stand-in-token';

interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
  authorization: string | undefined;
}

/** A stand-in BlaakTasks on loopback: records each `tools/call` and answers with the task. */
async function fakeBlaakTasks(): Promise<{ url: string; calls: ToolCall[]; close(): Promise<void> }> {
  const calls: ToolCall[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const request = JSON.parse(body) as { id: number; params: { name: string; arguments: Record<string, unknown> } };
      calls.push({ tool: request.params.name, args: request.params.arguments, authorization: req.headers.authorization });
      const task = { id: TASK, title: TITLE, status: 'In progress', today: true, pullRequests: [], brief: '', progress: [], url: 'https://www.notion.so/x' };
      const value = request.params.name === 'list' ? [task] : task;
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
