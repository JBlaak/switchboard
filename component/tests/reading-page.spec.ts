/**
 * A page a session shows (`show_page`): laid over the session's terminal in a
 * sandboxed frame, put away, brought back from the session tray.
 *
 * Main is played by emitting `onPageShown`, as its page tool does once the
 * session calls `show_page`, and by answering the page in `getSessionLinks`,
 * as main does once the call is in the session's transcript. The round trip
 * from the MCP server to the window stays in e2e/tests/reading-page.spec.ts;
 * the tool's protocol, the service and the pages slice are unit tested
 * (test/page-tool.test.ts).
 */
import {test, expect} from '../support/test';
import {terminalHeader} from '../../e2e/support/app';
import {LABEL, S} from '../../e2e/fixtures/standard';
import {FIXTURE_NOW} from '../../e2e/support/fixture-home';
import {openSession} from '../support/running-session';
import type {Page} from '@playwright/test';
import type {FakeApi} from '../support/fake-api';
import type {LinkedPage} from '../../src/domain/session/links';

const TITLE = 'General Terms and Conditions: AI clauses';

const HTML = [
    '<h1>AI clauses</h1>',
    '<p>These clauses apply when the Supplier uses <strong>AI systems</strong> in delivering the Services.</p>',
    '<h2>1. Definitions</h2>',
    '<ol><li><strong>AI system</strong>: a machine-based system that infers from input how to generate output.</li>',
    '<li><strong>Customer Data</strong>: all data the Customer provides to the Supplier.</li></ol>',
    '<h2>2. Use of AI systems</h2>',
    '<p>The Supplier may use AI systems, provided that:</p>',
    '<ol><li>Customer Data is not used to train models;</li><li>output is reviewed by a person.</li></ol>',
    '<h3>2.1 Disclosure</h3>',
    '<p>On request, the Supplier lists the AI systems it uses. See <a href="#liability">liability</a>.</p>',
    '<h2 id="liability">3. Liability</h2>',
    '<blockquote>The Supplier remains liable for output it delivers, whether or not an AI system produced it.</blockquote>',
].join('');

const readingPage = (page: Page) => page.getByRole('dialog', {name: TITLE});
const article = (page: Page) => page.frameLocator('iframe.rp-frame');
/** The page's row in the session tray's Links (#343), which the bar opens on hover. */
async function reopenRow(page: Page) {
    await terminalHeader(page).getByText(LABEL.loginFix, {exact: true}).hover();
    const tray = page.getByRole('region', {name: 'Session tools'});
    await expect(tray).toHaveClass(/is-open/);
    return tray.locator('.tray-link', {hasText: TITLE});
}

/** `sessionId` shows a page, as main sends it, and lists it in its links from then on. */
async function showPage(api: FakeApi, sessionId: string, shown: {title: string; html: string}): Promise<void> {
    const link: LinkedPage = {
        kind: 'page',
        key: 'page:toolu_page',
        title: shown.title,
        id: 'toolu_page',
        shownAt: FIXTURE_NOW,
        status: null,
    };
    api.handle('getSessionLinks', (id) => (id === sessionId ? [link] : []));
    await api.emit('onPageShown', {...shown, sessionId, shownAt: FIXTURE_NOW});
}

// Answered for the session tray, which the bar above the terminal opens on hover.

test.describe('smoke', () => {
    test('scripts in a page do not run', async ({page, api}) => {
        /* Given */
        await openSession(page, api, LABEL.loginFix, S.loginFix);

        /* When */
        await showPage(api, S.loginFix, {
            title: TITLE,
            html: '<p id="target">untouched</p><script>document.getElementById("target").textContent = "ran"</script>',
        });

        /* Then */
        await expect(article(page).locator('#target')).toHaveText('untouched');
    });

    test('the back button returns to the terminal', async ({page, api}) => {
        /* Given */
        await openSession(page, api, LABEL.loginFix, S.loginFix);
        await showPage(api, S.loginFix, {title: TITLE, html: HTML});
        await expect(readingPage(page)).toBeVisible();

        /* When */
        await readingPage(page)
            .getByRole('button', {name: /Back to terminal/})
            .click();

        /* Then */
        await expect(readingPage(page)).toHaveCount(0);
        await expect(await reopenRow(page)).toBeEnabled();
    });
});
