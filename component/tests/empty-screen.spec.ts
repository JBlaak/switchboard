/**
 * The empty screen: what a first launch shows, with nothing indexed and
 * nothing running.
 *
 * What Patch says for a given board — the beats, the weather and holiday
 * asides, the usage lines, pokes and drops — is unit tested
 * (test/patch-mood.test.ts, test/patch-calendar.test.ts). These check that
 * the board reaches Patch: each appearance, the weather and usage from main,
 * the running count, and a reaction beating a slow gather.
 *
 * The managers beside Patch (#416) take their pose from the inbox's counts,
 * which is unit tested (test/inbox-slice.test.ts); these check that a manager
 * stands there only once it is set up, follows the counts main pushes, and
 * where it stands on a tall and a short window. The Merge manager (#440)
 * stands fourth from day one; its pose, counter and bubble from the lanes are
 * unit tested (test/merge-manager-figure.test.ts).
 *
 * The screenshots of these screens are in e2e/tests/empty-screen.spec.ts.
 */
import {test, expect} from '../support/test';
import {openSession} from '../support/running-session';
import {searchBox, sidebar, terminalStatus} from '../../e2e/support/app';
import {LABEL, S} from '../../e2e/fixtures/standard';
import {FIXTURE_NOW} from '../../e2e/support/fixture-home';
import {captured} from '../fixtures/captured';
import type {Page} from '@playwright/test';
import type {InboxSummary} from '../../src/domain/inbox/model';
import type {LandedView, LaneStage, MergeManagerState} from '../../src/domain/merge-manager/model';

/** What the empty screen and the settings page ask main for, besides what a test says. */
test.use({fixture: null});

// ── Patch on the empty screen ──

const FIRST_LINE = 'Zzz… nothing running. Wake me when you start something.';

/** Patch's speech bubble, by what it says. */
const says = (page: Page, line: string | RegExp) => page.locator('#placeholder').getByText(line);

/** Put the empty screen away behind global settings and bring it back. */
async function hideAndShowEmptyScreen(page: Page): Promise<void> {
    await page.getByRole('button', {name: 'Global settings', exact: true}).click();
    await page.getByRole('menuitem', {name: 'All settings…'}).click();
    await expect(page.getByText('Global Settings', {exact: true})).toBeVisible();
    await page.getByRole('button', {name: 'Save Settings', exact: true}).click();
    await expect(page.getByText('Global Settings', {exact: true})).toBeHidden();
}

test('greets with Patch and an empty session list, with its next line each time it is shown', async ({page}) => {
    /* Then */
    await expect(says(page, FIRST_LINE)).toBeVisible();
    await expect(searchBox(page)).toBeVisible();
    await expect(page.getByText('Recent', {exact: true})).toHaveCount(0);

    /* When */
    await hideAndShowEmptyScreen(page);

    /* Then */
    await expect(says(page, 'All quiet on the board. Start a session?')).toBeVisible();

    /* When */
    await hideAndShowEmptyScreen(page);

    /* Then */
    await expect(says(page, FIRST_LINE)).toBeVisible();
});

test.describe('patch', () => {
    test.describe('near the limit, in the rain', () => {
        test.use({
            answers: {
                getWeather: {sky: 'rain', isDay: true, location: 'Utrecht', fetchedAt: 0, sunrise: null, sunset: null},
                getUsage: {
                    limits: [
                        {
                            kind: 'session',
                            label: 'Current session',
                            model: null,
                            percent: 88,
                            reset: '6pm (UTC)',
                            severity: 'normal',
                        },
                    ],
                },
            },
        });

        test('warms the weather as the window loads, and reads the usage, then the weather', async ({page, api}) => {
            /* Then */
            await expect.poll(() => api.callsTo('getWeather').length).toBeGreaterThanOrEqual(1);
            await expect(says(page, 'We’re at 88% of the limit. Easy does it.')).toBeVisible();

            /* When */
            await hideAndShowEmptyScreen(page);

            /* Then */
            // The fixture's clock is in June: summer rain means a puddle, not an umbrella.
            await expect(says(page, 'Warm rain! Puddle jumping later.')).toBeVisible();
            await expect(page.locator('#placeholder .patch-scene')).toHaveClass(/patch-has-puddle/);
            await expect(page.locator('#placeholder .patch-scene')).not.toHaveClass(/patch-has-umbrella/);
        });
    });

    test.describe('with its family', () => {
        test.use({fixture: captured('standard')});

        test('reads the running count; a running session is out with the family, and choosing its Patch opens it again', async ({
            page,
            api,
        }) => {
            /* Given */
            await expect(says(page, FIRST_LINE)).toBeVisible();
            await openSession(page, api, LABEL.loginFix, S.loginFix);

            /* When */
            // Clicking the list anywhere but on a row or a control (here, a section
            // heading) puts the session away.
            await sidebar(page).getByText('Recent', {exact: true}).click();

            /* Then */
            // The second appearance with one session running.
            await expect(says(page, 'Missed you.')).toBeVisible();
            const family = page.getByTestId('patch-family');
            const member = family.locator(`[data-member="${S.loginFix}"]`);
            await expect(member).toBeVisible();
            await expect(member).toHaveAttribute('aria-label', /^Fix the login redirect loop: /);

            /* When */
            // Members never stand still (they breathe, bob or wave), so take the keyboard path in.
            await member.focus();
            await page.keyboard.press('Enter');

            /* Then */
            await expect(terminalStatus(page)).toHaveText('Running');
            await expect(page.locator('#placeholder')).toBeHidden();
        });
    });

    test.describe('when the weather never answers', () => {
        test.use({answers: {getWeather: () => new Promise(() => {})}, fakeTimers: true});

        test('a poke or a drop answers at once and wins over the gather in flight, which goes with what it has after 1.5s', async ({
            page,
        }) => {
            /* Given */
            await expect(says(page, FIRST_LINE)).toBeVisible();
            const patch = page.locator('#placeholder').getByRole('button', {name: 'Poke Patch'});

            /* When */
            await hideAndShowEmptyScreen(page);
            // The gather for this appearance is waiting on the weather now.
            await patch.click();

            /* Then */
            await expect(says(page, 'Hey, that tickles!')).toBeVisible({timeout: 500});

            /* When */
            await page.clock.fastForward(2000);

            /* Then */
            await expect(says(page, 'Hey, that tickles!')).toBeVisible();

            /* When */
            // The poke won, so this is still only Patch's second appearance.
            await hideAndShowEmptyScreen(page);

            /* Then */
            // The gather is still waiting on the weather.
            await expect(says(page, 'All quiet on the board. Start a session?')).toHaveCount(0);

            /* When */
            await page.clock.fastForward(1600);

            /* Then */
            await expect(says(page, 'All quiet on the board. Start a session?')).toBeVisible();

            /* When */
            await hideAndShowEmptyScreen(page);
            const box = (await patch.boundingBox())!;
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.down();
            await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 30, {steps: 8});
            await page.mouse.up();

            /* Then */
            const dropLine = /Wheee!|Again! Again!|all wobbly|Right back where I belong|Where was I|That was fun/;
            await expect(says(page, dropLine)).toBeVisible({timeout: 500});
            const line = await says(page, dropLine).textContent();

            /* When */
            await page.clock.fastForward(2000);

            /* Then */
            await expect(says(page, line!)).toBeVisible();
        });
    });
});

// ── The managers (#416) ──

/** A manager's figure, by its accessible name. */
const manager = (page: Page, name: string | RegExp) => page.getByTestId('patch-managers').getByRole('button', {name});

/** The scene element a manager's pose is drawn from. */
const pose = (page: Page, kind: 'bug' | 'issue' | 'merge') => page.locator(`[data-manager="${kind}"] .patch-mgr-scene`);

/** Main's push after a poll, for both managers set up. */
function summary(bug: [number, number], issue: number): InboxSummary {
    return {
        bug: {unread: bug[0], urgent: bug[1]},
        issue: {unread: issue, urgent: 0},
        configured: {bug: true, issue: true},
        triaging: [],
    };
}

/** Main's push of one Switchboard lane, its PRs #1, #2, … at these stages. */
function lanes(...stages: LaneStage[]): MergeManagerState {
    const pullRequests: LandedView[] = stages.map((stage, index) => ({
        key: `movelab/connect#${index + 1}`,
        repository: 'movelab/connect',
        number: index + 1,
        title: `PR ${index + 1}`,
        url: `https://github.com/movelab/connect/pull/${index + 1}`,
        headRef: `branch-${index + 1}`,
        lane: 'switchboard',
        landedAt: FIXTURE_NOW - (60 - index) * 60_000,
        stage,
        setAside: null,
        errand: null,
        place: null,
    }));
    return {
        lanes: [{repository: 'movelab/connect', kind: 'switchboard', approvalLostOnPush: false, pullRequests}],
        needsYou: stages.filter((stage) => stage.kind === 'needsYou').length,
    };
}

test.describe('managers', () => {
    test('stand on the floor beside Patch once set up, posed and counted as the inbox says', async ({page, api}) => {
        /* Given */
        await expect(says(page, FIRST_LINE)).toBeVisible();
        await expect(manager(page, /Bug manager|Issue manager/)).toHaveCount(0);

        /* When */
        await api.emit('onInboxChanged', summary([3, 1], 2));

        /* Then */
        await expect(manager(page, 'Bug manager, 3 unread')).toBeVisible();
        await expect(pose(page, 'bug')).toHaveClass(/patch-mgr-s-urgent/);
        await expect(manager(page, 'Issue manager, 2 unread')).toBeVisible();
        await expect(pose(page, 'issue')).toHaveClass(/patch-mgr-s-unread/);
        await expect(page.getByTestId('patch-managers').getByText('Ask Patch')).toBeVisible();

        /* When */
        await api.emit('onInboxChanged', summary([0, 0], 0));

        /* Then */
        await expect(manager(page, 'Bug manager')).toBeVisible();
        await expect(pose(page, 'bug')).toHaveClass(/patch-mgr-s-calm/);
        await expect(manager(page, 'Issue manager')).toBeVisible();
        await expect(pose(page, 'issue')).toHaveClass(/patch-mgr-s-calm/);
    });

    test('stand in a row under Patch in a window too short for the family card', async ({page, api}) => {
        /* Given */
        await expect(says(page, FIRST_LINE)).toBeVisible();
        await api.emit('onInboxChanged', summary([1, 0], 4));

        /* When */
        await page.setViewportSize({width: 1280, height: 700});

        /* Then */
        await expect(page.getByTestId('patch-family')).toBeHidden();
        await expect(manager(page, 'Bug manager, 1 unread')).toBeVisible();
        await expect(manager(page, 'Issue manager, 4 unread')).toBeVisible();
    });

    test('only the manager that is set up stands there, and goes when it is not any more', async ({page, api}) => {
        /* When */
        await api.emit('onInboxChanged', {...summary([2, 0], 5), configured: {bug: true, issue: false}});

        /* Then */
        await expect(manager(page, 'Bug manager, 2 unread')).toBeVisible();
        await expect(manager(page, /Issue manager/)).toHaveCount(0);

        /* When */
        await api.emit('onInboxChanged', {...summary([2, 0], 5), configured: {bug: false, issue: false}});

        /* Then */
        await expect(manager(page, /Bug manager|Issue manager/)).toHaveCount(0);
        await expect(manager(page, 'Merge manager')).toBeVisible();
    });

    test('the Merge manager stands fourth on the floor from day one, posed and counted as the lanes say', async ({
        page,
        api,
    }) => {
        /* Given */
        await expect(says(page, FIRST_LINE)).toBeVisible();
        await expect(manager(page, 'Merge manager')).toBeVisible();
        await expect(pose(page, 'merge')).toHaveClass(/patch-mgr-s-idle/);

        /* When */
        await api.emit('onInboxChanged', summary([0, 0], 0));

        /* Then: Bug manager, Patch, Issue manager, Merge manager, left to right */
        const left = async (locator: ReturnType<Page['locator']>) => (await locator.boundingBox())!.x;
        const row = page.getByTestId('patch-managers');
        await expect(row.locator('[data-manager="bug"]')).toBeVisible();
        const xs = [
            await left(row.locator('[data-manager="bug"]')),
            await left(row.getByText('Ask Patch')),
            await left(row.locator('[data-manager="issue"]')),
            await left(row.locator('[data-manager="merge"]')),
        ];
        expect([...xs].sort((a, b) => a - b)).toEqual(xs);

        /* When */
        await api.emit(
            'onMergeManagerChanged',
            lanes({kind: 'head', step: 'checks'}, {kind: 'waiting', willConflict: false, position: null}),
        );

        /* Then */
        await expect(pose(page, 'merge')).toHaveClass(/patch-mgr-s-moving/);

        /* When */
        await api.emit(
            'onMergeManagerChanged',
            lanes({kind: 'needsYou', reason: {kind: 'changes-requested'}}, {kind: 'merged', at: FIXTURE_NOW - 60_000}),
        );

        /* Then */
        await expect(manager(page, 'Merge manager, 1 needs you')).toBeVisible();
        await expect(pose(page, 'merge')).toHaveClass(/patch-mgr-s-needsYou/);
        await expect(row.getByRole('status')).toHaveText('#2 merged');
    });

    test.describe('with a project on Watch issues', () => {
        // What main answers at launch with a project on Watch issues and nothing read yet.
        test.use({
            fixture: captured('standard'),
            answers: {
                inboxSummary: {
                    bug: {unread: 0, urgent: 0},
                    issue: {unread: 0, urgent: 0},
                    configured: {bug: false, issue: true},
                    triaging: [],
                },
            },
        });

        test('the Issue manager stands there from launch, calm with nothing read yet', async ({page}) => {
            /* Then */
            await expect(manager(page, 'Issue manager')).toBeVisible();
            await expect(pose(page, 'issue')).toHaveClass(/patch-mgr-s-calm/);
            await expect(manager(page, /Bug manager/)).toHaveCount(0);
        });
    });
});
