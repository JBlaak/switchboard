/**
 * The Plan tab (#124): the Session work page's tabs, the plan from a stubbed
 * back end drawn as a diagram, and an issue's detail.
 *
 * Levels, states, warnings, geometry and the slice are unit tested in
 * test/plan-*.test.ts; this proves the wiring to main: the tab asks for the
 * session's plans and shows them, a click opens an issue, a level that
 * clears between two polls celebrates once, Start level starts one session
 * that coordinates an agent per Ready issue, and a start refused over an
 * existing branch offers to continue on it, open its session, or delete it
 * and start again. A start handed off to a VM shows each step main reports
 * while it goes.
 *
 * Main is answered as the e2e host stubs answered it (component/support/
 * project-page.ts); a session started is the `openTerminal` call the renderer
 * makes, with the directory and the options the CLI would be launched with.
 */
import {test, expect} from '../support/test';
import {
    openSession,
    PROJECT_PAGE_ANSWERS,
    runSessions,
    stubOverviews,
    stubPlans,
    stubSessionWork,
} from '../support/project-page';
import type {FakeApi} from '../support/fake-api';
import {sessionRow, terminalHeader} from '../../e2e/support/app';
import {STUB_HANDOFF_HOST} from '../../e2e/support/main-process';
import {LABEL, S} from '../../e2e/fixtures/standard';
import {sessionWorkStub} from '../../e2e/fixtures/session-work';
import {LOGIN_PLAN, LOGIN_PLAN_ON_LEVEL_3, plansStub} from '../../e2e/fixtures/plans';
import type {PlansStub} from '../../e2e/support/main-process';
import type {Page} from '@playwright/test';

function workPage(page: Page) {
    return page.getByRole('region', {name: /^Session work for /});
}

function diagram(page: Page) {
    return page.getByTestId('plan-diagram');
}

function node(page: Page, number: number) {
    return diagram(page).getByRole('button', {name: new RegExp(`^#${number} `)});
}

function detail(page: Page) {
    return page.getByRole('complementary', {name: 'Issue detail'});
}

/** The sessions started since `before` calls to `openTerminal`: new ones only. */
function startedSince(api: FakeApi, before: number) {
    return api
        .callsTo('openTerminal')
        .slice(before)
        .filter(([, , isNew]) => isNew);
}

test.use({answers: {...PROJECT_PAGE_ANSWERS, openRepository: true}});

/** Session work and the plans answered as the e2e stubs did, with sessions that start. */
function setUp(api: FakeApi, plans: PlansStub) {
    stubSessionWork(api, sessionWorkStub());
    stubOverviews(api, {});
    runSessions(api);
    return stubPlans(api, plans);
}

/** The login-fix session on screen, its Session work open on the Plan tab. */
async function openPlanTab(page: Page, api: FakeApi) {
    await openSession(page, api, LABEL.loginFix, S.loginFix);
    await page.keyboard.press('Meta+g');
    await workPage(page).getByRole('tab', {name: 'Plan'}).click();
}

test.describe('the tab', () => {
    test.beforeEach(({api}) => {
        setUp(api, plansStub());
    });

    test('the Plan tab shows the session’s plan, and a click opens an issue’s detail', async ({page, api}) => {
        /* Given */
        await openSession(page, api, LABEL.loginFix, S.loginFix);
        await page.keyboard.press('Meta+g');
        await expect(workPage(page).getByRole('heading', {level: 1})).toHaveText('Work · ' + LABEL.loginFix);

        /* When */
        await workPage(page).getByRole('tab', {name: 'Plan'}).click();

        /* Then */
        await expect(workPage(page).getByRole('tab', {name: 'Plan'})).toHaveAttribute('aria-selected', 'true');
        await expect(workPage(page).getByRole('heading', {name: 'Login rework'})).toBeVisible();
        await expect(workPage(page).getByText('Level 2 of 3')).toBeVisible();
        for (const number of [1301, 1302, 1303, 1304, 1305]) await expect(node(page, number)).toBeVisible();
        await expect(node(page, 1302)).toContainText('Session ' + LABEL.loginFix);
        await expect(diagram(page).getByLabel('Level 2, You are here')).toBeVisible();

        /* When */
        await node(page, 1302).click();

        /* Then */
        await expect(detail(page).getByRole('heading', {name: 'Stop the login redirect loop'})).toBeVisible();
        await expect(detail(page)).toContainText('1 of 2 ticked on GitHub');
        await expect(detail(page).getByRole('button', {name: /^#1301 /})).toBeVisible();
        await expect(detail(page).getByRole('button', {name: /^#1304 /})).toBeVisible();

        /* When */
        await page.keyboard.press('ArrowDown');

        /* Then */
        await expect(detail(page).getByRole('heading', {name: 'Remember me for 30 days'})).toBeVisible();

        /* When */
        await detail(page).getByRole('button', {name: 'Open issue'}).click();

        /* Then */
        await expect
            .poll(() => api.callsTo('openExternal'))
            .toContainEqual(['https://github.com/acme/api/issues/1303']);

        /* When */
        await page.keyboard.press('Escape');

        /* Then */
        await expect(detail(page)).toHaveCount(0);
        await expect(workPage(page)).toBeVisible();

        /* When */
        await workPage(page).getByRole('button', {name: /^#22 /}).click();

        /* Then */
        await expect(node(page, 48)).toBeAttached();
    });
});

/** `PLAN_POLL_MS` in `plan/install-plan`: how often an open plan view asks again (W4). */
const PLAN_POLL_MS = 60_000;

test.describe('level up', () => {
    test.use({fakeTimers: true});
    let plans: ReturnType<typeof stubPlans>;

    test.beforeEach(({api}) => {
        plans = setUp(api, plansStub());
    });

    test('a level that clears between two polls celebrates once', async ({page, api}) => {
        /* Given: the plan is seen on level 2 for the first time, which does not celebrate */
        await openPlanTab(page, api);
        await expect(workPage(page).getByText('Level 2 of 3')).toBeVisible();
        const cheer = page.getByRole('status').filter({hasText: 'Level up!'});
        await expect(cheer).toHaveCount(0);

        /* When: level 2 clears before the next poll */
        plans.set(plansStub(LOGIN_PLAN_ON_LEVEL_3));
        await page.clock.fastForward(PLAN_POLL_MS);

        /* Then: Patch's line, alone under reduced motion */
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

/** The login plan with #1302's PR gone: #1302 and #1303 both Ready on level 2. */
const TWO_READY = {
    ...LOGIN_PLAN,
    issues: LOGIN_PLAN.issues.map((i) => (i.number === 1302 ? {...i, pullRequests: []} : i)),
};

test.describe('start level', () => {
    test.beforeEach(({api}) => {
        setUp(api, {...plansStub(TWO_READY), prepareWorktrees: true});
    });

    test('Start level starts one session with an agent per Ready issue, coordinated from it', async ({page, api}) => {
        /* Given */
        await openPlanTab(page, api);
        const before = api.callsTo('openTerminal').length;

        /* When */
        await diagram(page).getByRole('button', {name: 'Start level'}).click();

        /* Then */
        const confirm = workPage(page).getByRole('group', {name: 'Start level'});
        await expect(confirm).toContainText('Start a session with 2 agents?');
        await expect(confirm).toContainText('#1302, #1303');

        /* When */
        await confirm.getByRole('button', {name: 'Start session'}).click();

        /* Then */
        await expect(workPage(page).getByText('Started a session with 2 agents.')).toBeVisible();
        await expect.poll(() => startedSince(api, before)).toHaveLength(1);
        const [, project, , options] = startedSince(api, before)[0];
        expect(options?.addDirs?.split(',')).toEqual(
            expect.arrayContaining([
                project + '/.claude/worktrees/1302-issue',
                project + '/.claude/worktrees/1303-issue',
            ]),
        );
        const prompt = options?.initialPrompt;
        expect(prompt).toContain('You coordinate level 2 of #1300: 2 issues');
        expect(prompt).toContain('one agent per issue with the Agent tool');
        expect(prompt).toContain(
            '- #1302: worktree ' + project + '/.claude/worktrees/1302-issue (branch 1302-issue). Work on #1302.',
        );
        expect(prompt).toContain(
            '- #1303: worktree ' + project + '/.claude/worktrees/1303-issue (branch 1303-issue). Work on #1303.',
        );
    });
});

test.describe('an existing branch', () => {
    let plans: ReturnType<typeof stubPlans>;

    /* #1303 is Ready, and its branch exists from an archived session. */
    test.beforeEach(({api}) => {
        plans = setUp(api, {
            ...plansStub(TWO_READY),
            prepareWorktrees: true,
            existingBranches: {issues: [1303], session: S.graphqlSpike},
        });
    });

    async function startOn1303(page: Page, api: FakeApi) {
        await openPlanTab(page, api);
        await node(page, 1303).click();
        await detail(page).getByRole('button', {name: 'Start session on #1303'}).click();
        return detail(page).getByRole('alert', {name: 'Branch exists'});
    }

    test('Continue work starts a session in its worktree, told to pick up the work', async ({page, api}) => {
        /* Given */
        const refused = await startOn1303(page, api);
        const before = api.callsTo('openTerminal').length;
        await expect(refused).toContainText(
            'in a worktree with 2 uncommitted files and 1 commit not on the default branch',
        );

        /* When */
        await refused.getByRole('button', {name: 'Continue work'}).click();

        /* Then */
        await expect.poll(() => startedSince(api, before)).toHaveLength(1);
        const [, cwd, , options] = startedSince(api, before)[0];
        expect(cwd).toMatch(/\/\.claude\/worktrees\/1303-issue$/);
        expect(options?.initialPrompt).toBe('Continue work on #1303.');
        expect(plans.existingAsked).toEqual([null, 'reuse']);
    });

    test('Delete asks once more, then starts afresh', async ({page, api}) => {
        /* Given */
        const refused = await startOn1303(page, api);
        const before = api.callsTo('openTerminal').length;

        /* When */
        await refused.getByRole('button', {name: 'Delete worktree and branch…'}).click();

        /* Then */
        const confirm = detail(page).getByRole('alertdialog', {name: 'Delete worktree and branch'});
        await expect(confirm).toContainText(
            'Delete its worktree and branch, with 2 uncommitted files and 1 commit not on the default branch?',
        );
        expect(plans.existingAsked).toEqual([null]);

        /* When */
        await confirm.getByRole('button', {name: 'Delete and start again'}).click();

        /* Then */
        await expect.poll(() => startedSince(api, before)).toHaveLength(1);
        expect(startedSince(api, before)[0][3]?.initialPrompt).toBe('Work on #1303.');
        expect(plans.existingAsked).toEqual([null, 'replace']);
    });

    test('Open its session puts the session that worked on it on screen, archived or not', async ({page, api}) => {
        /* Given */
        const refused = await startOn1303(page, api);

        /* When */
        await refused.getByRole('button', {name: 'Open its session'}).click();

        /* Then */
        await expect.poll(() => api.callsTo('openTerminal').map(([id]) => id)).toContain(S.graphqlSpike);
        await expect(terminalHeader(page)).toContainText(LABEL.graphqlSpike);
    });
});

test.describe('a start handed off to a VM', () => {
    const LINES = ['Connecting to joris@devbox.local', 'Handing acme-api off to joris@devbox.local'];
    const LINE_DELAY_MS = 600;

    test.use({answers: {...PROJECT_PAGE_ANSWERS, handoffHosts: [STUB_HANDOFF_HOST]}});

    test.beforeEach(({api}) => {
        setUp(api, {...plansStub(), prepareWorktrees: true});
        // As main does: each progress line pushed in turn, then the answer.
        api.handle('handOffForStart', async (localPath) => {
            const pause = () => new Promise((resolve) => setTimeout(resolve, LINE_DELAY_MS));
            for (const line of LINES) {
                await pause();
                await api.emit('onHandoffProgress', localPath, line);
            }
            await pause();
            return {ok: false as const, error: 'The VM went away'};
        });
    });

    test('shows each step main reports while it goes, then why it stopped', async ({page, api}) => {
        /* Given: with a VM about, the row's Hand off action sits over the label's middle, so click its start */
        await sessionRow(page, LABEL.loginFix)
            .first()
            .click({position: {x: 4, y: 4}});
        await expect.poll(() => api.callsTo('openTerminal').map(([id]) => id)).toContain(S.loginFix);
        await page.keyboard.press('Meta+g');
        await workPage(page).getByRole('tab', {name: 'Plan'}).click();
        await node(page, 1303).click();
        await detail(page).getByRole('button', {name: 'Start session on #1303'}).click();

        /* When */
        await detail(page)
            .getByRole('button', {name: 'Hand off to ' + STUB_HANDOFF_HOST.label})
            .click();

        /* Then */
        const progress = detail(page).getByRole('status', {name: 'Starting on ' + STUB_HANDOFF_HOST.label});
        await expect(detail(page).getByRole('button', {name: 'Starting on joris@devbox.local…'})).toBeVisible();
        await expect(progress.locator('[aria-current="step"]')).toHaveText(
            'Handing acme-api off to joris@devbox.local…',
        );
        await expect(progress.locator('li.is-done')).toHaveText([
            /Making the worktree on this Mac/,
            /Getting the hand-off to joris@devbox\.local ready/,
            /Connecting to joris@devbox\.local/,
        ]);

        /* Then */
        await expect(detail(page).getByRole('alert')).toContainText('The VM went away');
        await expect(progress).toHaveCount(0);
    });
});

test.describe('wayfinder map', () => {
    /** The login plan as a wayfinder map: #1303 claimed, #1302 without its PR, so on the frontier. */
    const map = {
        ...LOGIN_PLAN,
        wayfinder: true,
        issues: LOGIN_PLAN.issues.map((i) =>
            i.number === 1302
                ? {...i, pullRequests: [], ticketType: 'grilling' as const}
                : i.number === 1303
                  ? {...i, claimed: true, ticketType: 'research' as const}
                  : i,
        ),
    };

    test.beforeEach(({api}) => {
        setUp(api, plansStub(map));
    });

    test('a map offers its launchers instead of Start level, and Next ticket starts /wayfinder on it', async ({
        page,
        api,
    }) => {
        /* Given */
        await openPlanTab(page, api);
        const launchers = workPage(page).getByRole('group', {name: 'Wayfinder map'});
        await expect(launchers).toBeVisible();
        await expect(diagram(page).getByRole('button', {name: 'Start level'})).toHaveCount(0);
        await expect(node(page, 1303)).toContainText('In progress');
        await expect(node(page, 1302)).toContainText('grilling');
        const before = api.callsTo('openTerminal').length;

        /* When */
        await launchers.getByRole('button', {name: 'Next ticket'}).click();

        /* Then */
        await expect.poll(() => startedSince(api, before)).toHaveLength(1);
        expect(startedSince(api, before)[0][3]?.initialPrompt).toBe('/wayfinder 1300');
    });
});

test.describe('the hand-off question on a start', () => {
    test.use({answers: {...PROJECT_PAGE_ANSWERS, handoffHosts: [STUB_HANDOFF_HOST]}});

    /** The gap between the bottom of the hand-off question and the top of the actions row it replaced the start in. */
    async function gapAboveActions(page: Page) {
        const question = await detail(page).getByRole('group', {name: 'Hand off to a VM'}).boundingBox();
        const actions = await detail(page).locator('.pv-actions').boundingBox();
        return actions!.y - (question!.y + question!.height);
    }

    for (const {name, plans, number, label} of [
        {name: 'Start session', plans: () => plansStub(), number: 1303, label: 'Start session on #1303'},
        {
            name: 'Start /wayfinder',
            plans: () => plansStub({...LOGIN_PLAN, wayfinder: true}),
            number: 1303,
            label: 'Start /wayfinder on #1303',
        },
    ]) {
        test(`${name} asks right above where its button was, not up the pane`, async ({page, api}) => {
            /* Given */
            setUp(api, plans());
            await sessionRow(page, LABEL.loginFix)
                .first()
                .click({position: {x: 4, y: 4}});
            await expect.poll(() => api.callsTo('openTerminal').map(([id]) => id)).toContain(S.loginFix);
            await page.keyboard.press('Meta+g');
            await workPage(page).getByRole('tab', {name: 'Plan'}).click();
            await node(page, number).click();

            /* When */
            await detail(page).getByRole('button', {name: label}).click();

            /* Then */
            await expect(
                detail(page).getByRole('button', {name: 'Hand off to ' + STUB_HANDOFF_HOST.label}),
            ).toBeVisible();
            expect(await gapAboveActions(page)).toBeGreaterThanOrEqual(0);
            expect(await gapAboveActions(page)).toBeLessThan(24);
        });
    }
});
