/**
 * Your review on the Session work page (#77): commenting a line of a PR's
 * diff, the pending review and its bar, and the threads already on GitHub.
 *
 * Nothing here reaches GitHub: the page's writes are recorded by the stub
 * (`sessionWorkReviews`), and what GitHub would say afterwards is pushed as a
 * snapshot, as the poll would.
 */
import { test, expect } from '../support/test';
import { openSession } from '../support/app';
import { pushEvent, sessionWorkActions, sessionWorkReviews } from '../support/main-process';
import { LABEL, S } from '../fixtures/standard';
import { FIRST_PR_ID, LOGIN_FIX_WORK, loginFixWorkWithReview, sessionWorkStub } from '../fixtures/session-work';
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

  test('a + shows on the hovered line and opens the composer under it; Add to review sends the comment', async ({ page, home, app }) => {
    await openLoginFixWork(page, home);
    const row = line(page, 11);
    const plus = row.getByRole('button', { name: 'Comment on line 11' });
    await expect(plus).toHaveCSS('opacity', '0');
    await row.hover();
    await expect(plus).toHaveCSS('opacity', '1');
    await plus.click();

    const form = composer(page);
    await expect(form.getByText('Comment on line 11', { exact: true })).toBeVisible();
    const field = form.getByRole('textbox', { name: 'Comment on line 11' });
    await expect(field).toBeFocused();
    // The composer sits right under its line.
    await expect(sessionFile(page).locator('[data-comment-line="11"][data-comment-side="RIGHT"] + .sw-notes')).toContainText('Add to review');

    // The page's own keys stay out of the text.
    await field.pressSequentially('Return early, and keep the jump.');
    await expect(workPage(page)).toBeVisible();
    await form.getByRole('button', { name: 'Add to review' }).click();
    await expect.poll(() => sessionWorkReviews(app)).toEqual([
      { comment: { ...COMMENT_BASE, line: 11, side: 'RIGHT', body: 'Return early, and keep the jump.' } },
    ]);
    await expect(composer(page)).toHaveCount(0);
  });

  test('c comments on the focused line; Esc closes the composer before the page', async ({ page, home, app }) => {
    await openLoginFixWork(page, home);
    // A deleted line is on the old side.
    const deleted = line(page, 12, 'LEFT');
    await deleted.click();
    await expect(deleted).toBeFocused();
    await page.keyboard.press('c');
    const field = composer(page).getByRole('textbox', { name: 'Comment on line 12 (old)' });
    await expect(field).toBeFocused();

    await field.fill('Why remove this?');
    await page.keyboard.press('Escape');
    await expect(composer(page)).toHaveCount(0);
    await expect(workPage(page)).toBeVisible();
    await expect(deleted).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(workPage(page)).toHaveCount(0);
    expect(await sessionWorkReviews(app)).toEqual([]);
  });

  test('in the split view, either side of a line takes a comment; Cancel closes it', async ({ page, home, app }) => {
    await openLoginFixWork(page, home);
    await page.keyboard.press('u');
    await expect(sessionFile(page).locator('.sw-dl.is-pair').first()).toBeVisible();

    const left = line(page, 11, 'LEFT');
    await left.hover();
    await sessionFile(page).getByRole('button', { name: 'Comment on line 11' }).first().click();
    const form = composer(page);
    await form.getByRole('textbox', { name: 'Comment on line 11 (old)' }).fill('Old side');
    await form.getByRole('button', { name: 'Add to review' }).click();
    await expect.poll(() => sessionWorkReviews(app)).toEqual([
      { comment: { ...COMMENT_BASE, line: 11, side: 'LEFT', body: 'Old side' } },
    ]);

    const right = line(page, 13, 'RIGHT');
    await right.click();
    await page.keyboard.press('c');
    await expect(composer(page).getByText('Comment on line 13', { exact: true })).toBeVisible();
    await composer(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(composer(page)).toHaveCount(0);
  });

  test('a merged PR\'s diff takes no comments', async ({ page, home }) => {
    await openLoginFixWork(page, home);
    await workPage(page).getByRole('button', { name: /^Done/ }).click();
    await workPage(page).getByRole('navigation', { name: 'Work items' }).getByRole('button', { name: /Log the redirect chain/ }).click();
    const diff = workPage(page).getByTestId('session-work-diff');
    await expect(diff.locator('.sw-dl[data-kind="add"]')).toHaveCount(1);
    await expect(diff.locator('.sw-dl-plus')).toHaveCount(0);
    await expect(diff.locator('[data-comment-line]')).toHaveCount(0);
  });
});

test.describe('a comment GitHub refuses', () => {
  test.use({ stubs: { sessionWork: { ...sessionWorkStub(), refuseReview: 'Could not add the comment: Line is not part of the diff' } } });

  test('keeps the composer, what was written, and says why', async ({ page, home }) => {
    await openLoginFixWork(page, home);
    await line(page, 11).hover();
    await line(page, 11).getByRole('button', { name: 'Comment on line 11' }).click();
    const field = composer(page).getByRole('textbox');
    await field.fill('Kept');
    await composer(page).getByRole('button', { name: 'Add to review' }).click();
    await expect(composer(page).getByRole('alert')).toHaveText('Could not add the comment: Line is not part of the diff');
    await expect(field).toHaveValue('Kept');
  });
});

test.describe('review threads', () => {
  test.use({
    stubs: {
      sessionWork: { ...sessionWorkStub(), snapshots: { ...sessionWorkStub().snapshots, [S.loginFix]: loginFixWorkWithReview() } },
    },
  });

  function thread(page: Page, id: string) {
    return workPage(page).locator(`[data-thread-id="${id}"]`);
  }

  test('show inline under their line: author, Bot badge, age and body; resolved dimmed; outdated at the top', async ({ page, home }) => {
    await openLoginFixWork(page, home);
    await expect(workPage(page).getByRole('group', { name: 'Actions' }).getByRole('button', { name: 'Fix comments (4)' })).toBeVisible();

    const open = sessionFile(page).locator('[data-comment-line="12"][data-comment-side="RIGHT"] + .sw-notes [data-thread-id="PRRT_open"]');
    await expect(open).toContainText('SL');
    await expect(open).toContainText('sam-lee');
    await expect(open).toContainText('2h ago');
    await expect(open).toContainText('Why null rather than a redirect?');
    await expect(open.getByText('Bot', { exact: true })).toHaveCount(0);

    const bot = thread(page, 'PRRT_bot');
    await expect(bot.getByText('Bot', { exact: true })).toBeVisible();
    await expect(bot).toContainText('coderabbitai');

    const resolved = sessionFile(page).locator('[data-comment-line="11"][data-comment-side="LEFT"] + .sw-notes [data-thread-id="PRRT_resolved"]');
    await expect(resolved).toHaveClass(/\bis-resolved\b/);
    await expect(resolved).toContainText('Resolved by sam-lee');
    await expect(resolved.getByRole('button', { name: 'Have Claude fix' })).toHaveCount(0);

    await expect(thread(page, 'PRRT_needs_you').getByText('needs you', { exact: true })).toBeVisible();

    const outdated = sessionFile(page).getByRole('group', { name: 'Outdated comments' });
    await expect(outdated).toContainText('This helper moved.');
    // At the top of its file, before the lines.
    await expect(sessionFile(page).locator('.sw-file-head + .sw-notes.is-outdated')).toHaveCount(1);
  });

  test('Have Claude fix hands over just that thread; while Claude has it, it says so', async ({ page, home, app }) => {
    await openLoginFixWork(page, home);
    await thread(page, 'PRRT_bot').getByRole('button', { name: 'Have Claude fix' }).click();
    await expect.poll(() => sessionWorkActions(app)).toEqual([
      { sessionId: S.loginFix, itemId: FIRST_PR_ID, action: 'fix-comments', threadIds: ['PRRT_bot'] },
    ]);

    await pushEvent(app, EVENT.sessionWorkSnapshot, loginFixWorkWithReview({ fixing: ['PRRT_bot'] }));
    await expect(thread(page, 'PRRT_bot').getByText('Claude is on it', { exact: true })).toBeVisible();
    await expect(thread(page, 'PRRT_bot').getByRole('button', { name: 'Have Claude fix' })).toHaveCount(0);
    await expect(thread(page, 'PRRT_open').getByRole('button', { name: 'Have Claude fix' })).toBeVisible();
  });
});

test.describe('a pending review', () => {
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

  test('shows its comments inline in amber, and the bar finishes it three ways', async ({ page, home, app }) => {
    await openLoginFixWork(page, home);
    const comment = sessionFile(page).locator('[data-comment-line="11"][data-comment-side="RIGHT"] + .sw-notes')
      .getByTestId('session-work-pending-comment');
    await expect(comment).toContainText('Pending · goes out with your review');
    await expect(comment).toContainText('Return early instead.');

    const bar = workPage(page).getByRole('region', { name: 'Pending review' });
    await expect(bar).toContainText('Review in progress · 1 pending');
    await bar.getByRole('button', { name: 'Discard' }).click();
    await expect.poll(async () => (await sessionWorkReviews(app)).length).toBe(1);
    await bar.getByRole('button', { name: 'Submit only' }).click();
    await expect.poll(async () => (await sessionWorkReviews(app)).length).toBe(2);
    await bar.getByRole('button', { name: 'Submit & have Claude fix' }).click();
    await expect.poll(() => sessionWorkReviews(app)).toEqual(['discard', 'submit', 'fix'].map(mode => ({
      review: { sessionId: S.loginFix, itemId: FIRST_PR_ID, mode },
    })));

    // Once GitHub says the review went out, the bar goes.
    await pushEvent(app, EVENT.sessionWorkSnapshot, LOGIN_FIX_WORK);
    await expect(bar).toHaveCount(0);
  });
});
