/**
 * A page a session shows (`show_page`): laid over the session's terminal,
 * put away with Esc, brought back from the terminal header.
 *
 * The tool's protocol, the service and the pages slice are unit tested
 * (test/page-tool.test.ts). These keep what only the running app can show:
 * the round-trip from the MCP server to the window, the sandboxed frame,
 * where the keyboard goes, and how it looks.
 */
import {test, expect, forEachAppearance} from '../support/test';
import {expectScreen, openSession, terminalHeader} from '../support/app';
import {showPage} from '../support/pages';
import {LABEL, S} from '../fixtures/standard';
import type {Page} from '@playwright/test';

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
const reopenButton = (page: Page) => terminalHeader(page).getByRole('button', {name: 'Page'});

test.describe('smoke', () => {
    test('a page comes up over the terminal, Esc puts it away and the header brings it back', async ({page, home}) => {
        /* Given */
        await openSession(page, home, LABEL.loginFix, S.loginFix);

        /* When */
        const result = await showPage(home, S.loginFix, {title: TITLE, html: HTML});

        /* Then */
        expect(result.isError).toBe(false);
        await expect(readingPage(page)).toBeVisible();
        await expect(article(page).getByRole('heading', {name: '2. Use of AI systems'})).toBeVisible();
        await expect(readingPage(page).getByRole('navigation', {name: 'Outline'})).toBeVisible();
        await expect(reopenButton(page)).toHaveCount(0);

        /* When */
        await article(page).locator('body').press('Escape');

        /* Then */
        await expect(readingPage(page)).toHaveCount(0);
        await expect(reopenButton(page)).toBeVisible();

        /* When */
        await reopenButton(page).click();

        /* Then */
        await expect(readingPage(page)).toBeVisible();
        await expect(reopenButton(page)).toHaveCount(0);
    });

    test('scripts in a page do not run', async ({page, home}) => {
        /* Given */
        await openSession(page, home, LABEL.loginFix, S.loginFix);

        /* When */
        await showPage(home, S.loginFix, {
            title: TITLE,
            html: '<p id="target">untouched</p><script>document.getElementById("target").textContent = "ran"</script>',
        });

        /* Then */
        await expect(article(page).locator('#target')).toHaveText('untouched');
    });

    test('the back button returns to the terminal', async ({page, home}) => {
        /* Given */
        await openSession(page, home, LABEL.loginFix, S.loginFix);
        await showPage(home, S.loginFix, {title: TITLE, html: HTML});
        await expect(readingPage(page)).toBeVisible();

        /* When */
        await readingPage(page)
            .getByRole('button', {name: /Back to terminal/})
            .click();

        /* Then */
        await expect(readingPage(page)).toHaveCount(0);
        await expect(reopenButton(page)).toBeVisible();
    });
});

forEachAppearance(() => {
    test('reading page', async ({page, home}) => {
        /* Given */
        await openSession(page, home, LABEL.loginFix, S.loginFix);

        /* When */
        await showPage(home, S.loginFix, {title: TITLE, html: HTML});

        /* Then */
        await expect(article(page).getByRole('heading', {name: '3. Liability'})).toBeVisible();
        await expectScreen(page, 'reading-page');
    });
});
