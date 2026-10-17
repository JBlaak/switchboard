/**
 * The sidebar footer: the running count, the activity line main writes into,
 * the quota gauges and the update notice.
 *
 * The timing rules (the activity line's linger, the five-minute usage poll)
 * run on fake timers, so they are checked by jumping the clock rather than by
 * waiting it out. What each part shows for a given state (gauge colours, the
 * notice's labels, what installing asks) is decided in
 * src/renderer/ui/footer/footer-view.ts and tested in test/footer-view.test.ts.
 */
import { test, expect, forEachAppearance } from '../support/test';
import { expectScreen, openSession, sidebarFooter } from '../support/app';
import { hostStubCalls, openedExternally, pushEvent, setHostStub } from '../support/main-process';
import { answerDialogs, dialogsAsked } from '../support/native-dialogs';
import { EVENT } from '../../src/ipc/channels';
import { LABEL, S } from '../fixtures/standard';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import type { UpdateNotice } from '../../src/domain/update/release';
import type { Usage } from '../../src/domain/usage/usage';

const USAGE_POLL_MS = 5 * 60 * 1000;

const UPDATE: UpdateNotice = {
  version: '9.1.0',
  pageUrl: 'https://github.com/JBlaak/switchboard/releases/tag/v9.1.0',
  installable: true,
};

/** Two shared windows at the given percentages. */
function usageAt(session: number, week: number): Usage {
  return {
    limits: [
      { kind: 'session', label: 'Current session', model: null, percent: session, reset: '6pm (UTC)', severity: 'normal' },
      { kind: 'weekly_all', label: 'Week (all models)', model: null, percent: week, reset: 'Jun 12 at 9am (UTC)', severity: 'normal' },
    ],
  };
}

/** A gauge, by its tooltip: the full label, the percentage and the reset. */
function gauge(page: Page, tooltip: string): Locator {
  return sidebarFooter(page).getByTitle(tooltip, { exact: true });
}

function noticeButton(page: Page, name: string): Locator {
  return sidebarFooter(page).getByRole('button', { name, exact: true });
}

/** A line from main's indexer, as `onStatusUpdate` delivers it. */
async function statusUpdate(app: ElectronApplication, text: string, kind: string): Promise<void> {
  await pushEvent(app, EVENT.statusUpdate, text, kind);
}

test.describe('activity line', () => {
  test.use({ fakeTimers: true });

  test('shows what main writes; only a done message lingers, for three seconds', async ({ page, app }) => {
    /* When */
    await statusUpdate(app, 'Indexed 3 sessions', 'done');
    await statusUpdate(app, 'Indexing 4 of 9…', 'progress');

    /* Then */
    const progress = sidebarFooter(page).getByText('Indexing 4 of 9…', { exact: true });
    await expect(progress).toBeVisible();
    await expect(sidebarFooter(page).getByText('Indexed 3 sessions')).toHaveCount(0);

    /* When */
    await page.clock.fastForward(10_000);

    /* Then */
    // The done message's linger was cancelled with it.
    await expect(progress).toBeVisible();

    /* When */
    await statusUpdate(app, 'Indexed 9 sessions', 'done');
    await page.clock.fastForward(2_500);

    /* Then */
    const done = sidebarFooter(page).getByText('Indexed 9 sessions', { exact: true });
    await expect(done).toBeVisible();

    /* When */
    await page.clock.fastForward(1_000);

    /* Then */
    await expect(done).toHaveCount(0);
  });
});

test.describe('quota gauges', () => {
  test.use({ fakeTimers: true });

  test('show the usage fetched at launch, and fetch it again every five minutes', async ({ page, app }) => {
    /* Given */
    const session = gauge(page, 'Current session: 42% — resets 6pm (UTC)');
    await expect(session).toBeVisible();
    await setHostStub(app, 'usage', usageAt(85, 90));
    const before = (await hostStubCalls(app)).getUsage;

    /* When */
    await page.clock.fastForward(USAGE_POLL_MS - 10_000);

    /* Then */
    expect((await hostStubCalls(app)).getUsage).toBe(before);
    await expect(session).toHaveText('5h42%');
    await expect(gauge(page, 'Week (all models): 67% — resets Jun 12 at 9am (UTC)')).toHaveText('Week67%');

    /* When */
    await page.clock.fastForward(10_000);

    /* Then */
    await expect(gauge(page, 'Current session: 85% — resets 6pm (UTC)')).toBeVisible();
    expect((await hostStubCalls(app)).getUsage).toBe(before + 1);
  });

  test('keep what they show when a fetch fails, and hide when one has no windows', async ({ page, app }) => {
    /* Given */
    const session = gauge(page, 'Current session: 42% — resets 6pm (UTC)');
    await expect(session).toBeVisible();
    await setHostStub(app, 'usageFails', true);
    const before = (await hostStubCalls(app)).getUsage;

    /* When */
    await page.clock.fastForward(USAGE_POLL_MS);

    /* Then */
    await expect.poll(async () => (await hostStubCalls(app)).getUsage).toBe(before + 1);
    await expect(session).toBeVisible();

    /* When */
    await setHostStub(app, 'usageFails', false);
    await setHostStub(app, 'usage', null);
    await page.clock.fastForward(USAGE_POLL_MS);

    /* Then */
    await expect(session).toBeHidden();
    await expect(sidebarFooter(page).getByText(/%$/)).toHaveCount(0);
  });
});

test.describe('update notice', () => {
  test('links to the release page when main announces one the app cannot install', async ({ page, app }) => {
    /* When */
    await pushEvent(app, EVENT.updateAvailable, { ...UPDATE, installable: false });

    /* Then */
    await expect(sidebarFooter(page).getByText('Version 9.1.0 is available', { exact: true })).toBeVisible();

    /* When */
    await noticeButton(page, 'View').click();

    /* Then */
    await expect.poll(() => openedExternally(app)).toContain(UPDATE.pageUrl);
    expect((await hostStubCalls(app)).installUpdate).toBe(0);
  });

  test.describe('found before launch', () => {
    test.use({ stubs: { update: UPDATE } });

    test('is shown from the start, and dismisses that version only, until the window reloads', async ({ page, app }) => {
      /* Given */
      const notice = sidebarFooter(page).getByText(/^Version [\d.]+ is available$/);
      await expect(sidebarFooter(page).getByText('Version 9.1.0 is available', { exact: true })).toBeVisible();

      /* When */
      await noticeButton(page, 'Dismiss').click();

      /* Then */
      await expect(notice).toBeHidden();

      /* When */
      await pushEvent(app, EVENT.updateAvailable, UPDATE);

      /* Then */
      await expect(notice).toBeHidden();

      /* When */
      await pushEvent(app, EVENT.updateAvailable, { ...UPDATE, version: '9.2.0' });

      /* Then */
      await expect(sidebarFooter(page).getByText('Version 9.2.0 is available', { exact: true })).toBeVisible();

      /* When */
      // Held in memory only: a fresh window offers the dismissed version again.
      await page.reload();

      /* Then */
      await expect(sidebarFooter(page).getByText('Version 9.1.0 is available', { exact: true })).toBeVisible();
    });

    test('counts the running sessions, asks before stopping them, and offers a retry when the install fails', async ({ page, app, home }) => {
      /* Given */
      await openSession(page, home, LABEL.loginFix, S.loginFix);
      await setHostStub(app, 'installUpdate', false);

      /* When */
      // The count is taken after a load; reloading the window loads again with
      // the session still running in main.
      await page.reload();

      /* Then */
      await expect(sidebarFooter(page).getByText('1 running', { exact: true })).toBeVisible();

      /* When */
      await answerDialogs(page, false);
      await noticeButton(page, 'Install').click();

      /* Then */
      await expect.poll(() => dialogsAsked(page)).toEqual(['Restarting to update stops 1 running session. Install now?']);
      await expect(noticeButton(page, 'Install')).toBeEnabled();
      expect((await hostStubCalls(app)).installUpdate).toBe(0);

      /* When */
      await answerDialogs(page, true);
      await noticeButton(page, 'Install').click();

      /* Then */
      await expect(sidebarFooter(page).getByText('Update failed', { exact: true })).toBeVisible();
      expect((await hostStubCalls(app)).installUpdate).toBe(1);

      /* When */
      // An install that works never answers: the app quits from under it.
      await setHostStub(app, 'installUpdate', 'pending');
      await noticeButton(page, 'Retry').click();

      /* Then */
      await expect(noticeButton(page, 'Installing…')).toBeDisabled();
      expect((await hostStubCalls(app)).installUpdate).toBe(2);
    });
  });
});

forEachAppearance(() => {
  test.describe('busy', () => {
    test.use({ stubs: { update: UPDATE, usage: usageAt(63, 86) } });

    test('footer with an update, activity and low quota', async ({ page, app }) => {
      /* When */
      await statusUpdate(app, 'Indexing 4 of 9…', 'progress');

      /* Then */
      await expect(sidebarFooter(page).getByText('Indexing 4 of 9…')).toBeVisible();
      await expect(sidebarFooter(page).getByText('Version 9.1.0 is available')).toBeVisible();
      await expectScreen(page, 'footer-busy');
    });
  });
});
