/**
 * BlaakTasks in the renderer (#249, #250, #251): the Tasks page, switched on
 * in Settings, opened with ⌘T, and S on the task's row starting a session on
 * it; the project page's Tasks section, which lists the task linked to its
 * repo and starts it there with no routing, keeping the page; and a linked
 * session's task row in the session tray, its Task tab and its sidebar
 * marker.
 *
 * Main is answered as it answers with BlaakTasks on: the task as the
 * stand-in BlaakTasks of e2e/support/blaak-tasks.ts serves it, read by the
 * real parser, and a start prepared by the real prompt and branch rules. A
 * session started is the `openTerminal` call the renderer makes, and the link
 * the `taskSessionStarted` it sends after. That main then links the session,
 * pushes the link and sets the task In progress, through the real BlaakTasks
 * adapter, is walked in e2e/tests/tasks.spec.ts.
 *
 * The page's views, keys and routing outcomes are unit tested
 * (test/tasks-slice.test.ts, test/tasks-page-actions.test.ts), and what the
 * project page lists and its keys in test/project-page-tasks.test.ts.
 */
import {test, expect} from '../support/test';
import {fixtureProjectPath} from '../fixtures/captured';
import {openSession, PROJECT_PAGE_ANSWERS, runSessions, stubOverviews, stubSessionWork} from '../support/project-page';
import type {FakeApi} from '../support/fake-api';
import {sidebar, terminalHeader} from '../../e2e/support/app';
import {switchBlaakTasksOn, TASK, TITLE} from '../../e2e/support/blaak-tasks';
import {sessionWorkStub} from '../../e2e/fixtures/session-work';
import {LABEL, P, S} from '../../e2e/fixtures/standard';
import {parseTaskDetail} from '../../src/domain/tasks/parse';
import {taskBranchName, taskSessionPrompt} from '../../src/domain/tasks/start';
import type {TaskDetail} from '../../src/domain/tasks/model';
import type {LinkedTask} from '../../src/domain/session/links';

/** The stand-in BlaakTasks' URL; nothing listens there, as main is answered here. */
const BLAAKTASKS_URL = 'http://127.0.0.1:9/mcp';

/** The task as the stand-in BlaakTasks serves it (with `fields` over it), read as main reads it. */
function taskDetail(fields: Record<string, unknown> = {}): TaskDetail {
    return parseTaskDetail({
        id: TASK,
        title: TITLE,
        status: 'In progress',
        today: true,
        pullRequests: [],
        brief: '',
        progress: [],
        url: 'https://www.notion.so/x',
        ...fields,
    })!;
}

/**
 * Main with BlaakTasks set up in Claude Code: a watched list pushes the task
 * at once, `getTask` reads it, and a start is prepared in a worktree of
 * acme-api (the task's repo, or the project asked for) named after it.
 */
function answerTasks(api: FakeApi, detail: TaskDetail, {repo}: {repo: string | null}) {
    const project = fixtureProjectPath(P.acmeApi);
    api.answer('blaakTasksSetUp', true);
    api.answer('getTask', {kind: 'ok', value: detail});
    api.handle('listTasks', () => ({kind: 'ok' as const, value: [detail]}));
    api.handle('watchTasks', (watchId, query) => {
        // Main answers the watch, then pushes the list it asked BlaakTasks for.
        if (query)
            setTimeout(
                () =>
                    void api.emit('onTasksChanged', {
                        watchId,
                        query,
                        state: 'ok',
                        rows: [detail],
                        fetchedAt: Date.now(),
                    }),
                0,
            );
    });
    api.answer('unwatchTasks', undefined);
    api.handle('projectTasks', (projectPath) => (repo && projectPath === repo ? [TASK] : []));
    api.handle('prepareTaskStart', (request) => {
        const projectPath = request.projectPath ?? repo ?? project;
        const branch = taskBranchName(request.task.title);
        return {
            kind: 'ready' as const,
            projectPath,
            worktreePath: projectPath + '/.claude/worktrees/' + branch,
            branch,
            prompt: taskSessionPrompt(request.task),
        };
    });
    // Main links the started session, and answers it as the task's owner from then on.
    const sessions: string[] = [];
    api.handle('taskSessionStarted', (_task, sessionId) => {
        sessions.unshift(sessionId);
        return {ok: true};
    });
    api.handle('taskSessions', () => ({sessions: [...sessions], owner: sessions[0] ?? null}));
}

/** The session the renderer told main it started on the task, once it has. */
async function startedOnTask(api: FakeApi): Promise<string> {
    await expect.poll(() => api.callsTo('taskSessionStarted')).toHaveLength(1);
    const [task, sessionId] = api.callsTo('taskSessionStarted')[0];
    expect(task).toBe(TASK);
    return sessionId;
}

test.use({answers: PROJECT_PAGE_ANSWERS});

test.describe('the Tasks page', () => {
    test.use({answers: {...PROJECT_PAGE_ANSWERS}});

    test.beforeEach(({api}) => {
        stubOverviews(api, {});
        runSessions(api);
        answerTasks(api, taskDetail(), {repo: fixtureProjectPath(P.acmeApi)});
    });

    test('the Tasks page opens with ⌘T once BlaakTasks is on, and S starts a session on the task without leaving it', async ({
        page,
        api,
    }) => {
        /* Given: BlaakTasks set up in Claude Code, a repository the task is linked to, and no Tasks page yet */
        const projectPath = fixtureProjectPath(P.acmeApi);
        const tasksPage = page.getByRole('region', {name: 'Tasks'});
        const gear = page.getByRole('button', {name: 'Global settings', exact: true});
        const tasksItem = page.getByRole('menuitem', {name: 'Tasks'});
        await gear.click();
        await expect(tasksItem).toHaveCount(0);
        await page.keyboard.press('Escape');

        /* When: the URL is saved in Settings */
        await switchBlaakTasksOn(page, BLAAKTASKS_URL);

        /* Then: the gear's menu has its entry point, and ⌘T opens it on ★ Today with the task's row */
        await gear.click();
        await expect(tasksItem).toBeVisible();
        await page.keyboard.press('Escape');
        await page.keyboard.press('Meta+t');
        await expect(tasksPage).toBeFocused();
        await expect(tasksPage.getByRole('tab', {name: '★ Today'})).toHaveAttribute('aria-selected', 'true');
        await expect(tasksPage.getByRole('radio', {name: 'Work'})).toHaveAttribute('aria-checked', 'true');
        const row = tasksPage.locator(`[data-task-id="${TASK}"]`);
        await expect(row).toContainText(TITLE);
        await expect(row).toContainText('In progress');
        await expect(row).toHaveAttribute('aria-selected', 'true');

        /* When: one click on the row */
        await row.click();

        /* Then: its detail opens */
        await expect(tasksPage.getByRole('complementary', {name: 'Task detail'})).toContainText(TITLE);

        /* When: S on the row under the cursor, and extra instructions for it */
        await page.keyboard.press('s');
        await expect(tasksPage.getByRole('textbox', {name: 'Extra instructions'})).toBeFocused();
        await page.keyboard.type('Only the upload test.');
        await page.keyboard.press('Enter');

        /* Then: Claude started in the task's worktree with them, the page kept the main area, and the session has a sidebar row */
        await expect(row.getByRole('status')).toContainText('Started in');
        const owner = await startedOnTask(api);
        const [id, cwd, isNew, options] = api.callsTo('openTerminal').find(([started]) => started === owner)!;
        expect([id, cwd, isNew]).toEqual([owner, projectPath + '/.claude/worktrees/fix-the-flaky-upload-test', true]);
        expect(options?.initialPrompt).toMatch(/\n\nExtra instructions: Only the upload test\.$/);
        expect(api.callsTo('taskSessionStarted')).toEqual([[TASK, owner, projectPath]]);
        await expect(sidebar(page).locator(`[data-session-id="${owner}"]`)).toBeVisible();
        await expect(tasksPage).toBeVisible();

        /* When: Esc, for the start's answer, the detail and the page */
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');

        /* Then */
        await expect(tasksPage).toHaveCount(0);
    });
});

test.describe('the project page', () => {
    test.use({settings: {global: {blaakTasksUrl: BLAAKTASKS_URL}}});

    test.beforeEach(({api}) => {
        stubOverviews(api, {});
        runSessions(api);
        answerTasks(api, taskDetail(), {repo: fixtureProjectPath(P.acmeApi)});
    });

    test('the project page lists the repo’s linked task, and S starts it in this repo without leaving the page', async ({
        page,
        api,
    }) => {
        /* Given: BlaakTasks on, and the task linked to the repository */
        const projectPath = fixtureProjectPath(P.acmeApi);

        /* When: the project's page opens */
        await sidebar(page).locator(`[data-session-id="${S.loginFix}"]`).getByTestId('project-link').click();

        /* Then: its Tasks section lists the task */
        const projectPage = page.getByRole('region', {name: /^Project /});
        const section = projectPage.getByRole('region', {name: 'Tasks'});
        const row = section.locator(`[data-task-id="${TASK}"]`);
        await expect(row).toContainText(TITLE);
        await expect(row).toContainText('In progress');
        expect(api.callsTo('getTask').map(([task]) => task)).toContain(TASK);

        /* When: S on the task's row */
        await row.click();
        await expect(row).toHaveAttribute('aria-selected', 'true');
        await page.keyboard.press('s');

        /* Then: Claude started in the task's worktree in this repo, and the page kept the main area */
        await expect(row.getByRole('status')).toContainText('Started in');
        const owner = await startedOnTask(api);
        expect(api.callsTo('prepareTaskStart')).toEqual([[expect.objectContaining({projectPath})]]);
        const [, cwd] = api.callsTo('openTerminal').find(([started]) => started === owner)!;
        expect(cwd).toBe(projectPath + '/.claude/worktrees/fix-the-flaky-upload-test');
        await expect(sidebar(page).locator(`[data-session-id="${owner}"]`)).toBeVisible();
        await expect(projectPage).toBeVisible();
    });
});

test.describe('the task on its session', () => {
    test.use({settings: {global: {blaakTasksUrl: BLAAKTASKS_URL}}});

    const DETAIL = taskDetail({
        brief: 'The login page loops back to itself after the cookie expires.',
        progress: [
            {day: '2026-10-27', text: 'Claude started work'},
            {day: '2026-10-28', text: 'Found the cause: the cookie path'},
        ],
        pullRequests: ['https://github.com/acme/api/pull/1320'],
    });

    /** What main answers for the session's task while it is linked: one link, and the task by id. */
    let linked: string | null = null;

    test.beforeEach(({api}) => {
        linked = null;
        stubOverviews(api, {});
        stubSessionWork(api, sessionWorkStub());
        runSessions(api);
        answerTasks(api, DETAIL, {repo: null});
        api.handle('sessionTask', (sessionId) => (sessionId === S.loginFix ? linked : null));
        api.handle('sessionTasks', (): Record<string, string> => (linked ? {[S.loginFix]: linked} : {}));
        api.handle('getSessionLinks', (sessionId): LinkedTask[] =>
            sessionId === S.loginFix && linked
                ? [
                      {
                          kind: 'task',
                          key: 'task:' + linked,
                          title: TITLE,
                          id: linked,
                          url: DETAIL.url,
                          status: DETAIL.status,
                      },
                  ]
                : [],
        );
    });

    test('a linked session shows its task: the tray’s task row, the Task tab and the sidebar marker', async ({
        page,
        api,
    }) => {
        /* Given: BlaakTasks on, and a session on screen with no task */
        await openSession(page, api, LABEL.loginFix, S.loginFix);
        // The task is a row in the session tray's Links (#343), which hovering the bar opens.
        const tray = page.getByRole('region', {name: 'Session tools'});
        const taskRow = tray.locator('.tray-link').filter({hasText: TITLE});
        const marker = page.locator(`[data-session-id="${S.loginFix}"]`).getByTestId('session-task-marker');
        await expect(marker).toHaveCount(0);

        /* When: main links the session to the task, and tells the window */
        linked = TASK;
        await api.emit('onSessionTaskChanged', S.loginFix, TASK);

        /* Then: the tray's task row names the task and its status, and the row is marked */
        await expect(marker).toHaveAttribute('title', 'Task: ' + TITLE);
        // Links are asked as the tray opens: open it again until it has the new one.
        await expect(async () => {
            await page.mouse.move(600, 600);
            await expect(tray).not.toHaveClass(/is-open/);
            await terminalHeader(page).getByText(LABEL.loginFix, {exact: true}).hover();
            await expect(taskRow).toContainText('In progress', {timeout: 1000});
        }).toPass();

        /* When: the task row is clicked */
        await taskRow.click();

        /* Then: Session work opens on the Task tab, oldest progress first, with the PR's state */
        const work = page.getByRole('region', {name: /^Session work for /});
        await expect(work.getByRole('tab', {name: 'Task'})).toHaveAttribute('aria-selected', 'true');
        const tab = work.getByTestId('session-task-tab');
        await expect(tab.getByRole('heading', {name: TITLE})).toBeVisible();
        await expect(tab).toContainText('The login page loops back to itself after the cookie expires.');
        await expect(tab.locator('.st-log li')).toHaveText([/Claude started work/, /Found the cause: the cookie path/]);
        await expect(tab.getByRole('button', {name: '#1320 open'})).toBeVisible();
        for (const name of ['Mark done', 'Snooze', 'Open in Notion'])
            await expect(tab.getByRole('button', {name})).toBeVisible();

        /* When: its PR is clicked */
        await tab.getByRole('button', {name: '#1320 open'}).click();

        /* Then: the PR opens in the browser */
        await expect.poll(() => api.callsTo('openExternal')).toContainEqual(['https://github.com/acme/api/pull/1320']);

        /* When: main unlinks it, and tells the window */
        linked = null;
        await api.emit('onSessionTaskChanged', S.loginFix, null);

        /* Then: the tab and the marker go */
        await expect(work.getByRole('tab', {name: 'Task'})).toHaveCount(0);
        await expect(marker).toHaveCount(0);
    });
});
