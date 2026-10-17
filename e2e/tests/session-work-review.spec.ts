/**
 * Your review on the Session work page (#77): commenting a line of a PR's
 * diff, the pending review and its bar, and the threads already on GitHub.
 *
 * Nothing here reaches GitHub: the page's writes are recorded by the stub
 * (`sessionWorkReviews`), and what GitHub would say afterwards is pushed as a
 * snapshot, as the poll would.
 *
 * Where threads, pending comments and the composer go, which diffs take
 * comments, and what a refused comment leaves behind are unit tested in
 * test/session-work-review.test.ts; these tests prove the hover, the keys,
 * the focus and what reaches main.
 */
import { test, expect } from '../support/test';
import { openSession } from '../support/app';
import { pushEvent, sessionWorkActions, sessionWorkReviews } from '../support/main-process';
import { LABEL, S } from '../fixtures/standard';
import { FIRST_PR_ID, loginFixWorkWithReview, sessionWorkStub } from '../fixtures/session-work';
import { EVENT } from '../../src/ipc/channels';
import type { Page } from '@playwright/test';

function workPage(page: Page) {
  return page.getByRole('region', { name: /^Session work for / });
}

function sessionFile(page: Page) {
  return workPage(page).getByTestId('session-work-diff').getByRole('region', { name: 'src/session.ts', exact: true });
}

/** A unified row (or a split side) by the anchor a comment on it takes. */
function line(page: Page, number: number, side: 'LEFT' | 'RIGHT' = 'RIGHT') {
  return sessionFile(page).locator(`[data-comment-line="${number}"][data-comment-side="${side}"]`).first();
}

function composer(page: Page) {
  return workPage(page).getByTestId('session-work-composer');
}

async function openLoginFixWork(page: Page, home: Parameters<typeof openSession>[1]): Promise<void> {
  await openSession(page, home, LABEL.loginFix, S.loginFix);
  await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeFocused();
  await page.keyboard.press('Meta+g');
  await expect(workPage(page).getByRole('heading', { level: 1 })).toHaveText('Work · ' + LABEL.loginFix);
  await expect(sessionFile(page).locator('.sw-dl[data-kind="add"]')).toHaveCount(3);
}

const COMMENT_BASE = { sessionId: S.loginFix, itemId: FIRST_PR_ID, path: 'src/session.ts' };

test.describe('commenting a line', () => {
  test.use({ stubs: { sessionWork: sessionWorkStub() } });

  test('a + shows on the hovered line and opens the composer under it; Add to review sends the comment, from either side of the split view', async ({ page, home, app }) => {
    /* Given */
    await openLoginFixWork(page, home);
    const row = line(page, 11);
    const plus = row.getByRole('button', { name: 'Comment on line 11' });
    await expect(plus).toHaveCSS('opacity', '0');

    /* When */
    await row.hover();

    /* Then */
    await expect(plus).toHaveCSS('opacity', '1');

    /* When */
    await plus.click();

    /* Then */
    const form = composer(page);
    await expect(form.getByText('Comment on line 11', { exact: true })).toBeVisible();
    const field = form.getByRole('textbox', { name: 'Comment on line 11' });
    await expect(field).toBeFocused();
    // The composer sits right under its line.
    await expect(sessionFile(page).locator('[data-comment-line="11"][data-comment-side="RIGHT"] + .sw-notes')).toContainText('Add to review');

    /* When */
    // The page's own keys stay out of the text.
    await field.pressSequentially('Return early, and keep the jump.');
    await form.getByRole('button', { name: 'Add to review' }).click();

    /* Then */
    await expect(workPage(page)).toBeVisible();
    await expect.poll(() => sessionWorkReviews(app)).toEqual([
      { comment: { ...COMMENT_BASE, line: 11, side: 'RIGHT', body: 'Return early, and keep the jump.' } },
    ]);
    await expect(composer(page)).toHaveCount(0);

    /* When */
    await page.keyboard.press('u');
    await expect(sessionFile(page).locator('.sw-dl.is-pair').first()).toBeVisible();
    await line(page, 11, 'LEFT').hover();
    await sessionFile(page).getByRole('button', { name: 'Comment on line 11' }).first().click();
    await composer(page).getByRole('textbox', { name: 'Comment on line 11 (old)' }).fill('Old side');
    await composer(page).getByRole('button', { name: 'Add to review' }).click();

    /* Then */
    await expect.poll(async () => (await sessionWorkReviews(app)).at(-1)).toEqual(
      { comment: { ...COMMENT_BASE, line: 11, side: 'LEFT', body: 'Old side' } },
    );
  });

  test('c comments on the focused line; Esc closes the composer before the page', async ({ page, home, app }) => {
    /* Given */
    await openLoginFixWork(page, home);
    // A deleted line is on the old side.
    const deleted = line(page, 12, 'LEFT');
    await deleted.click();
    await expect(deleted).toBeFocused();

    /* When */
    await page.keyboard.press('c');

    /* Then */
    const field = composer(page).getByRole('textbox', { name: 'Comment on line 12 (old)' });
    await expect(field).toBeFocused();

    /* When */
    await field.fill('Why remove this?');
    await page.keyboard.press('Escape');

    /* Then */
    await expect(composer(page)).toHaveCount(0);
    await expect(workPage(page)).toBeVisible();
    await expect(deleted).toBeFocused();

    /* When */
    await page.keyboard.press('Escape');

    /* Then */
    await expect(workPage(page)).toHaveCount(0);
    expect(await sessionWorkReviews(app)).toEqual([]);
  });
});

test.describe('review threads and a pending review', () => {
  const pending = [{ path: 'src/session.ts', line: 11, side: 'RIGHT' as const, body: 'Return early instead.', threadId: 'PRRT_p1' }];
  test.use({
    stubs: {
      sessionWork: {
        ...sessionWorkStub(),
        // Started in the browser: it is on GitHub before the page opens.
        snapshots: { ...sessionWorkStub().snapshots, [S.loginFix]: loginFixWorkWithReview({ pending }) },
      },
    },
  });

  function thread(page: Page, id: string) {
    return workPage(page).locator(`[data-thread-id="${id}"]`);
  }

  test('show inline under their lines; the bar finishes the review three ways, and Have Claude fix hands over one thread', async ({ page, home, app }) => {
    /* Given */
    await openLoginFixWork(page, home);
    const bar = workPage(page).getByRole('region', { name: 'Pending review' });

    /* Then */
    const open = sessionFile(page).locator('[data-comment-line="12"][data-comment-side="RIGHT"] + .sw-notes [data-thread-id="PRRT_open"]');
    await expect(open).toContainText('sam-lee');
    await expect(open).toContainText('Why null rather than a redirect?');
    await expect(thread(page, 'PRRT_bot').getByText('Bot', { exact: true })).toBeVisible();
    const resolved = sessionFile(page).locator('[data-comment-line="11"][data-comment-side="LEFT"] + .sw-notes [data-thread-id="PRRT_resolved"]');
    await expect(resolved).toHaveClass(/\bis-resolved\b/);
    await expect(resolved).toContainText('Resolved by sam-lee');
    await expect(resolved.getByRole('button', { name: 'Have Claude fix' })).toHaveCount(0);
    await expect(thread(page, 'PRRT_needs_you').getByText('needs you', { exact: true })).toBeVisible();
    // Outdated threads sit at the top of their file, before the lines.
    await expect(sessionFile(page).locator('.sw-file-head + .sw-notes.is-outdated')).toContainText('This helper moved.');
    const comment = sessionFile(page).locator('[data-comment-line="11"][data-comment-side="RIGHT"] + .sw-notes')
      .getByTestId('session-work-pending-comment');
    await expect(comment).toContainText('Pending · goes out with your review');
    await expect(comment).toContainText('Return early instead.');
    await expect(bar).toContainText('Review in progress · 1 pending');

    /* When */
    await bar.getByRole('button', { name: 'Discard' }).click();
    await expect.poll(async () => (await sessionWorkReviews(app)).length).toBe(1);
    await bar.getByRole('button', { name: 'Submit only' }).click();
    await expect.poll(async () => (await sessionWorkReviews(app)).length).toBe(2);
    await bar.getByRole('button', { name: 'Submit & have Claude fix' }).click();

    /* Then */
    await expect.poll(() => sessionWorkReviews(app)).toEqual(['discard', 'submit', 'fix'].map(mode => ({
      review: { sessionId: S.loginFix, itemId: FIRST_PR_ID, mode },
    })));

    /* When */
    await thread(page, 'PRRT_bot').getByRole('button', { name: 'Have Claude fix' }).click();

    /* Then */
    await expect.poll(() => sessionWorkActions(app)).toEqual([
      { sessionId: S.loginFix, itemId: FIRST_PR_ID, action: 'fix-comments', threadIds: ['PRRT_bot'] },
    ]);

    /* When */
    // GitHub says the review went out, and Claude has the thread.
    await pushEvent(app, EVENT.sessionWorkSnapshot, loginFixWorkWithReview({ fixing: ['PRRT_bot'] }));

    /* Then */
    await expect(bar).toHaveCount(0);
    await expect(thread(page, 'PRRT_bot').getByText('Claude is on it', { exact: true })).toBeVisible();
    await expect(thread(page, 'PRRT_bot').getByRole('button', { name: 'Have Claude fix' })).toHaveCount(0);
    await expect(thread(page, 'PRRT_open').getByRole('button', { name: 'Have Claude fix' })).toBeVisible();
  });
});
