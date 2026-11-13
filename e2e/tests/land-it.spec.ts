/**
 * Land it (#436): pressing it in the session header hands the session's PR
 * to the Merge manager, turns the button into the landed pill and brings the
 * toast with its place in the lane; the toast's Undo unlands it.
 */
import {test, expect} from '../support/test';
import {openSession, terminalHeader} from '../support/app';
import {landRequests, stubLandIt} from '../support/main-process';
import {LABEL, S} from '../fixtures/standard';
import {landedView, mergeManagerState} from '../../src/domain/merge-manager/landed';
import {landedKey} from '../../src/domain/merge-manager/model';
import type {LandedPullRequest} from '../../src/domain/merge-manager/model';
import type {SessionLink} from '../../src/domain/session/links';

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

test('Land it in the session header shows the landed pill and the toast, and Undo unlands', async ({
    page,
    app,
    home,
}) => {
    /* Given: #1320 lands behind #1300, the lane's head */
    const lanes = mergeManagerState(
        [
            landedPr(1300, 1, {kind: 'head', step: 'checks'}),
            landedPr(1320, 2, {kind: 'waiting', willConflict: false, position: null}),
        ],
        new Map(),
    );
    await stubLandIt(app, {links: [pr(1320)], lanes, landed: landedView(lanes, landedKey(REPO, 1320))!});
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    const header = terminalHeader(page);
    await expect(header.getByText('PR #1320')).toBeVisible();

    /* When */
    await header.getByRole('button', {name: 'Land it'}).click();

    /* Then */
    await expect(header.getByRole('button', {name: /Landed · 2nd in api/})).toBeVisible();
    await expect(header.getByRole('button', {name: 'Land it'})).toHaveCount(0);
    const toast = page.getByTestId('land-toast');
    await expect(toast).toContainText("Landed #1320 · 2nd in api's lane");
    expect(await landRequests(app)).toEqual(['land acme/api#1320']);

    /* When */
    await toast.getByRole('button', {name: 'Undo'}).click();

    /* Then */
    await expect(toast).toHaveCount(0);
    await expect(header.getByRole('button', {name: 'Land it'})).toBeVisible();
    expect(await landRequests(app)).toEqual(['land acme/api#1320', 'unland acme/api#1320']);
});
