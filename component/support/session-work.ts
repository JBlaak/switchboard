/**
 * The Session work page's back end, played by the fake api from the same
 * `SessionWorkStub` the e2e harness installs in main (e2e/fixtures/session-work.ts):
 * which sessions can open, the snapshot each opens with, the diffs, the check
 * logs and the images. Review writes go through, or are refused with
 * `refuseReview`, and are read back with `api.callsTo`.
 *
 * Also the page's locators and the way into it from a running session.
 */
import {expect} from '@playwright/test';
import type {Page} from '@playwright/test';
import {imageStubKey} from '../../e2e/support/main-process';
import type {SessionWorkStub} from '../../e2e/support/main-process';
import {LABEL, S} from '../../e2e/fixtures/standard';
import {openSession} from './running-session';
import type {FakeApi} from './fake-api';
import type {Answers} from './default-answers';

/** Answers for `test.use({answers})`, standing in for git and `gh` as the e2e stub does. */
export function sessionWorkAnswers(work: SessionWorkStub): Answers {
    return {
        canOpenSessionWork: (sessionId) => work.canOpen.includes(sessionId),
        // No snapshot: main is still reading git, and the page stays a skeleton.
        openSessionWork: (sessionId) => work.snapshots[sessionId] ?? new Promise(() => {}),
        getSessionWorkDiff: ({itemId}) => {
            const diff = work.diffs?.[itemId];
            if (diff === 'never') return new Promise(() => {});
            return diff ?? {files: [], source: null};
        },
        sessionWorkComment: () => (work.refuseReview ? {ok: false, reason: work.refuseReview} : {ok: true}),
        sessionWorkReview: () => (work.refuseReview ? {ok: false, reason: work.refuseReview} : {ok: true}),
        getCheckLog: ({checkRunUrl}) => work.checkLogs?.[checkRunUrl] ?? null,
        sessionWorkImage: ({itemId, path, side}) => {
            const bytes = work.images?.[imageStubKey(itemId, path, side)];
            return bytes ? new Uint8Array(Buffer.from(bytes, 'base64')) : null;
        },
    };
}

export function workPage(page: Page) {
    return page.getByRole('region', {name: /^Session work for /});
}

export function workHeading(page: Page) {
    return workPage(page).getByRole('heading', {level: 1});
}

/** The terminal's keyboard target: xterm's hidden textarea. */
export function terminalInput(page: Page) {
    return page.getByRole('textbox', {name: 'Terminal input'});
}

/** Open the login-fix session and its page with Cmd+G, from the terminal. */
export async function openLoginFixWork(page: Page, api: FakeApi): Promise<void> {
    await openSession(page, api, LABEL.loginFix, S.loginFix);
    await expect(terminalInput(page)).toBeFocused();
    await page.keyboard.press('Meta+g');
    await expect(workHeading(page)).toHaveText('Work · ' + LABEL.loginFix);
}
