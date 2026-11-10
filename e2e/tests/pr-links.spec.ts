/**
 * Pull request links open the app's own diff viewer (#PR-links): a peek at
 * the diff first, then the full view on ↵ or Full view — the owning
 * session's work page with the PR selected, or a page of the PR's own when
 * no session opened it.
 *
 * What the peek's reducer does with answers, and which links count as PR
 * links, is unit tested in test/pr-peek.test.ts; which session owns a PR and
 * how a pull page behaves in test/pr-full-view.test.ts. These tests prove
 * the wired app: a click on a real link reaches main, the peek draws and
 * holds the keys, and both full views open.
 */
import {test, expect} from '../support/test';
import {openSession, openSessionTray} from '../support/app';
import {showPage} from '../support/pages';
import {endTurn} from '../support/questions';
import {EVENT} from '../../src/ipc/channels';
import {openedExternally, peekedPullRequests, pushEvent, sessionWorkReviews} from '../support/main-process';
import {cellPoint, expectTerminalText, findInTerminal} from '../support/terminal';
import {LABEL, S} from '../fixtures/standard';
import {LOGIN_LOOP_DIFF, LOGIN_FIX_WORK, sessionWorkStub} from '../fixtures/session-work';
import {parseUnifiedDiff} from '../../src/domain/session-work/diff';
import type {PullRequestPeek} from '../../src/domain/session-work/pull-request-link';
import type {SessionWorkSnapshot} from '../../src/domain/session-work/model';
import type {Page} from '@playwright/test';

const OWNED_URL = 'https://github.com/acme/api/pull/1320';
const ORPHAN_URL = 'https://github.com/acme/web/pull/7';
const ORPHAN_PAGE = 'pull:acme/web#7';

function peekOf(repository: string, number: number, title: string): PullRequestPeek {
    const url = `https://github.com/${repository}/pull/${number}`;
    return {
        ref: {repository, number},
        url,
        pr: {number, url, repository, title, state: 'open', closes: [], additions: 3, deletions: 2},
        files: parseUnifiedDiff(LOGIN_LOOP_DIFF),
    };
}

const PEEKS = {
    'acme/api#1320': peekOf('acme/api', 1320, 'Stop the login redirect loop'),
    'acme/web#7': peekOf('acme/web', 7, 'Teach the header to wrap'),
};

/** What main answers for the PR no session opened: one PR item, nothing to hand to Claude. */
const ORPHAN_WORK: SessionWorkSnapshot = {
    sessionId: ORPHAN_PAGE,
    repository: 'acme/web',
    items: [
        {
            id: 'pr:' + ORPHAN_URL,
            kind: 'pr',
            pr: {...PEEKS['acme/web#7'].pr!, nodeId: 'PR_web7'},
            location: null,
            diff: {kind: 'pull-request', repository: 'acme/web', number: 7},
            activity: null,
            otherRepository: true,
        },
    ],
    footprint: {worktrees: 0, branches: 0},
    queued: 0,
    gh: 'ok',
    updatedAt: LOGIN_FIX_WORK.updatedAt,
};

function stubs() {
    const work = sessionWorkStub();
    return {
        pullRequestPeeks: PEEKS,
        sessionWork: {
            ...work,
            canOpen: [...work.canOpen, ORPHAN_PAGE],
            snapshots: {...work.snapshots, [ORPHAN_PAGE]: ORPHAN_WORK},
            diffs: {
                ...work.diffs,
                ['pr:' + ORPHAN_URL]: {files: parseUnifiedDiff(LOGIN_LOOP_DIFF), source: 'github'},
            },
        },
    } as const;
}

function peek(page: Page) {
    return page.getByTestId('pr-peek');
}

/** The work page, a session's or a PR's own. */
function workPage(page: Page) {
    return page.locator('#session-work .sw-page');
}

/** Print a link into the session's terminal and click it, as a reader would. */
async function clickTerminalLink(page: Page, claude: {println(...lines: string[]): Promise<void>}, url: string) {
    // Below the band at the top that opens the session tray on hover.
    await claude.println(...Array<string>(10).fill(''));
    await claude.println(`Opened ${url} for review`);
    await expectTerminalText(page, S.loginFix, url);
    const at = await findInTerminal(page, S.loginFix, url);
    const point = await cellPoint(page, S.loginFix, at.column + 3, at.viewportRow);
    await page.mouse.move(point.x, point.y);
    await page.mouse.move(point.x + 1, point.y);
    await expect
        .poll(async () => {
            if (!(await peek(page).isVisible())) await page.mouse.click(point.x + 1, point.y);
            return peek(page).isVisible();
        })
        .toBe(true);
}

test.describe('a PR link', () => {
    test.use({stubs: stubs()});

    test('in the terminal peeks at the diff; ↵ opens its session’s work page with that PR selected', async ({
        page,
        home,
        app,
    }) => {
        /* Given */
        const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);

        /* When */
        await clickTerminalLink(page, claude, OWNED_URL);

        /* Then */
        await expect(peek(page)).toBeFocused();
        await expect(peek(page).locator('.pr-peek-title')).toHaveText('Stop the login redirect loop');
        const file = peek(page).getByRole('region', {name: 'src/session.ts', exact: true});
        await expect(file.locator('.sw-dl[data-kind="add"]')).toHaveCount(3);
        expect(await peekedPullRequests(app)).toEqual(['acme/api#1320']);
        expect(await openedExternally(app)).toEqual([]);

        /* When */
        await page.keyboard.press('Enter');

        /* Then */
        await expect(peek(page)).toHaveCount(0);
        await expect(workPage(page).getByRole('heading', {level: 1})).toHaveText('Work · ' + LABEL.loginFix);
        await expect(workPage(page).locator('.sw-item.is-selected')).toHaveAttribute('data-item-id', 'pr:' + OWNED_URL);
        await expect(workPage(page).locator('.sw-detail-title')).toContainText('Stop the login redirect loop');
    });

    test('Open on GitHub opens the browser, and Esc closes the peek back to the terminal', async ({
        page,
        home,
        app,
    }) => {
        /* Given */
        const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
        await clickTerminalLink(page, claude, ORPHAN_URL);

        /* When */
        await page.keyboard.press('o');

        /* Then */
        await expect.poll(() => openedExternally(app)).toEqual([ORPHAN_URL]);
        await expect(peek(page)).toBeVisible();

        /* When */
        await page.keyboard.press('Escape');

        /* Then */
        await expect(peek(page)).toHaveCount(0);
        await expect(page.getByRole('textbox', {name: 'Terminal input'})).toBeFocused();
    });

    test('no session opened opens a page of its own: its diff and your review, nothing for Claude', async ({
        page,
        home,
        app,
    }) => {
        /* Given */
        const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
        await clickTerminalLink(page, claude, ORPHAN_URL);

        /* When */
        await peek(page)
            .getByRole('button', {name: /Full view/})
            .click();

        /* Then */
        await expect(peek(page)).toHaveCount(0);
        const work = workPage(page);
        await expect(work.getByRole('heading', {level: 1})).toHaveText('acme/web #7 · Teach the header to wrap');
        await expect(work.getByRole('tablist')).toHaveCount(0);
        await expect(work.getByRole('button', {name: /Ship it|Fix CI|Rebase/})).toHaveCount(0);
        const file = work.getByTestId('session-work-diff').getByRole('region', {name: 'src/session.ts', exact: true});
        await expect(file.locator('.sw-dl[data-kind="add"]')).toHaveCount(3);

        /* When */
        const row = file.locator('[data-comment-line="11"][data-comment-side="RIGHT"]').first();
        await row.hover();
        await row.getByRole('button', {name: 'Comment on line 11'}).click();
        await work.getByTestId('session-work-composer').getByRole('textbox').fill('Wrap at 80?');
        await work
            .getByTestId('session-work-composer')
            .getByRole('button', {name: /Add to review/})
            .click();

        /* Then */
        await expect
            .poll(() => sessionWorkReviews(app))
            .toEqual([
                {
                    comment: expect.objectContaining({
                        sessionId: ORPHAN_PAGE,
                        itemId: 'pr:' + ORPHAN_URL,
                        path: 'src/session.ts',
                        line: 11,
                        body: 'Wrap at 80?',
                    }),
                },
            ]);

        /* When */
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');

        /* Then */
        await expect(work).toBeHidden();
    });

    test('in the session tray peeks too', async ({page, home, app}) => {
        /* Given */
        await openSession(page, home, LABEL.loginFix, S.loginFix);
        const tray = await openSessionTray(page);

        /* When */
        await tray.locator('a.tray-link[href="' + OWNED_URL + '"]').click();

        /* Then */
        await expect(peek(page)).toBeVisible();
        await expect.poll(() => peekedPullRequests(app)).toEqual(['acme/api#1320']);
        expect(await openedExternally(app)).toEqual([]);
    });

    test('on a page a session shows peeks over the page, and Esc gives the page back', async ({page, home, app}) => {
        /* Given */
        await openSession(page, home, LABEL.loginFix, S.loginFix);
        await showPage(home, S.loginFix, {
            title: 'Review notes',
            html: `<p>Look at <a href="${OWNED_URL}">the login fix</a> first.</p>`,
        });
        const reading = page.getByRole('dialog', {name: 'Review notes'});
        await expect(reading).toBeVisible();

        /* When */
        await page.frameLocator('iframe.rp-frame').getByRole('link', {name: 'the login fix'}).click();

        /* Then */
        await expect(peek(page)).toBeVisible();
        await expect(peek(page)).toBeFocused();
        expect(await peekedPullRequests(app)).toEqual(['acme/api#1320']);
        expect(await openedExternally(app)).toEqual([]);

        /* When */
        await page.keyboard.press('Escape');

        /* Then */
        await expect(peek(page)).toHaveCount(0);
        await expect(reading).toBeVisible();
    });

    test('on a grilling card peeks without touching the round', async ({page, home, app}) => {
        /* Given */
        await openSession(page, home, LABEL.loginFix, S.loginFix);
        await endTurn(
            home,
            S.loginFix,
            [
                `❓ **Q1** - **Merge [the login fix](${OWNED_URL}) first?**: It unblocks the cookie work.`,
                '',
                '➡️ Yes.',
            ].join('\n'),
        );
        const card = page.getByRole('region', {name: 'Grilling round from Claude'});
        await expect(card.getByRole('link', {name: 'the login fix'})).toBeVisible();

        /* When */
        await card.getByRole('link', {name: 'the login fix'}).click();

        /* Then */
        await expect(peek(page)).toBeFocused();
        expect(await peekedPullRequests(app)).toEqual(['acme/api#1320']);

        /* When */
        await page.keyboard.press('Escape');

        /* Then */
        await expect(peek(page)).toHaveCount(0);
        await expect(card).toBeVisible();
    });

    test('main hands over, from a stray anchor in the window, peeks too', async ({page, home, app}) => {
        /* Given */
        await openSession(page, home, LABEL.loginFix, S.loginFix);

        /* When */
        await pushEvent(app, EVENT.pullRequestLinkOpened, ORPHAN_URL);

        /* Then */
        await expect(peek(page)).toBeFocused();
        await expect(peek(page).locator('.pr-peek-title')).toHaveText('Teach the header to wrap');
        expect(await peekedPullRequests(app)).toEqual(['acme/web#7']);
    });
});
