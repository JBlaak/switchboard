/**
 * Land it (#436): pressing it in the session header hands the session's PR
 * to the Merge manager, turns the button into the landed pill and brings the
 * toast with its place in the lane; the toast's Undo unlands it.
 */
import {test, expect} from '../support/test';
import {openSession} from '../support/running-session';
import {terminalHeader} from '../../e2e/support/app';
import {LABEL, S} from '../../e2e/fixtures/standard';
import {landedView, mergeManagerState} from '../../src/domain/merge-manager/landed';
import {landedKey} from '../../src/domain/merge-manager/model';
import type {LandedPullRequest} from '../../src/domain/merge-manager/model';
import type {SessionLink} from '../../src/domain/session/links';
import type {FakeApi} from '../support/fake-api';

const REPO = 'acme/api';

function pr(number: number): SessionLink {
    return {
        kind: 'pr',
        key: `pr:https://github.com/${REPO}/pull/${number}`,
        title: 'Stop the login redirect loop',
        url: `https://github.com/${REPO}/pull/${number}`,
        repository: REPO,
        number,
        status: {state: 'open', checks: 'passing', dot: 'green', mine: true},
    };
}

function landedPr(number: number, landedAt: number, stage: LandedPullRequest['stage']): LandedPullRequest {
    return {
        key: landedKey(REPO, number),
        repository: REPO,
        number,
        title: 'PR ' + number,
        url: `https://github.com/${REPO}/pull/${number}`,
        headRef: 'fix/' + number,
        lane: 'switchboard',
        landedAt,
        stage,
        setAside: null,
        errand: null,
    };
}

/** #1320 lands behind #1300, the lane's head. */
const LANES = mergeManagerState(
    [
        landedPr(1300, 1, {kind: 'head', step: 'checks'}),
        landedPr(1320, 2, {kind: 'waiting', willConflict: false, position: null}),
    ],
    new Map(),
);

/**
 * Land it's back end, as main's Merge manager answers it: every session's
 * links are the PR, landing pushes the lanes it changed and answers the PR in
 * its lane, and unlanding pushes the empty lanes back.
 */
function answerLandIt(api: FakeApi): void {
    api.answer('getSessionLinks', [pr(1320)]);
    api.handle('mergeManagerLand', async () => {
        await api.emit('onMergeManagerChanged', LANES);
        return {ok: true as const, landed: landedView(LANES, landedKey(REPO, 1320))!};
    });
    api.handle('mergeManagerUnland', async () => {
        await api.emit('onMergeManagerChanged', {lanes: [], needsYou: 0});
        return {ok: true as const};
    });
}

/** Every Land it and Unland, as `land owner/repo#n`. */
function landRequests(api: FakeApi): string[] {
    return api.calls.flatMap((call) => {
        if (call.name === 'mergeManagerLand') return [`land ${call.args[0]}#${call.args[1]}`];
        if (call.name === 'mergeManagerUnland') return [`unland ${call.args[0]}#${call.args[1]}`];
        return [];
    });
}

test('Land it in the session header shows the landed pill and the toast, and Undo unlands', async ({page, api}) => {
    /* Given */
    answerLandIt(api);
    await openSession(page, api, LABEL.loginFix, S.loginFix);
    const header = terminalHeader(page);
    await expect(header.getByText('PR #1320')).toBeVisible();

    /* When */
    await header.getByRole('button', {name: 'Land it'}).click();

    /* Then */
    await expect(header.getByRole('button', {name: /Landed · 2nd in api/})).toBeVisible();
    await expect(header.getByRole('button', {name: 'Land it'})).toHaveCount(0);
    const toast = page.getByTestId('land-toast');
    await expect(toast).toContainText("Landed #1320 · 2nd in api's lane");
    expect(landRequests(api)).toEqual(['land acme/api#1320']);

    /* When */
    await toast.getByRole('button', {name: 'Undo'}).click();

    /* Then */
    await expect(toast).toHaveCount(0);
    await expect(header.getByRole('button', {name: 'Land it'})).toBeVisible();
    expect(landRequests(api)).toEqual(['land acme/api#1320', 'unland acme/api#1320']);
});

test('Land it shows up for a PR the session opened while it is on screen, once the CI watch hears of it', async ({
    page,
    api,
}) => {
    /* Given the session has no PR yet, and the lanes never move */
    api.answer('getSessionLinks', []);
    await openSession(page, api, LABEL.loginFix, S.loginFix);
    const header = terminalHeader(page);
    await expect(header.getByRole('button', {name: 'Land it'})).toHaveCount(0);

    /* When the session opens #1320 and the CI watch's next round finds it */
    api.answer('getSessionLinks', [pr(1320)]);
    await api.emit('onPrStatusChanged', {
        sessionId: S.loginFix,
        prs: [{number: 1320, dot: 'green'}],
        needsYou: false,
    });

    /* Then */
    await expect(header.getByText('PR #1320')).toBeVisible();
    await expect(header.getByRole('button', {name: 'Land it'})).toBeVisible();
});
