/**
 * The sidebar footer: the running count, the activity line main writes into,
 * the quota gauges and the update notice.
 *
 * The timing rules (the activity line's linger, the five-minute usage poll)
 * run on fake timers, so they are checked by jumping the clock rather than by
 * waiting it out.
 */
import { test, expect, forEachAppearance } from '../support/test';
import { expectScreen, openSession, sidebarFooter } from '../support/app';
import { hostStubCalls, openedExternally, pushEvent, setHostStub } from '../support/main-process';
import { EVENT } from '../../src/ipc/channels';
import { LABEL, S, emptyFixture } from '../fixtures/standard';
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

function gaugeFill(gaugeItem: Locator): Locator {
  return gaugeItem.getByTestId('quota-fill');
}

function noticeButton(page: Page, name: string): Locator {
  return sidebarFooter(page).getByRole('button', { name, exact: true });
}

/** A line from main's indexer, as `onStatusUpdate` delivers it. */
async function statusUpdate(app: ElectronApplication, text: string, kind: string): Promise<void> {
  await pushEvent(app, EVENT.statusUpdate, text, kind);
}

/** Answer the next `confirm()` and hand back what it asked. */
function answerConfirm(page: Page, accept: boolean): Promise<string> {
  return new Promise(resolve => {
    page.once('dialog', dialog => {
      const message = dialog.message();
      void (accept ? dialog.accept() : dialog.dismiss()).then(() => resolve(message));
    });
  });
}

test.describe('status summary', () => {
  test('counts the running sessions when the list loads', async ({ page, home }) => {
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    // The count is taken after a load; reloading the window loads again with
    // the session still running in main.
    await page.reload();
    await expect(sidebarFooter(page).getByText('1 running', { exact: true })).toBeVisible();
  });
});

test.describe('activity line', () => {
  test.use({ fakeTimers: true });

  test('a done message lingers for three seconds', async ({ page, app }) => {
    await statusUpdate(app, 'Indexed 3 sessions', 'done');
    const line = sidebarFooter(page).getByText('Indexed 3 sessions', { exact: true });
    await expect(line).toBeVisible();
    await page.clock.fastForward(2_500);
    await expect(line).toBeVisible();
    await page.clock.fastForward(1_000);
    await expect(line).toHaveCount(0);
  });

  test('a progress message stays until the next one replaces it', async ({ page, app }) => {
    await statusUpdate(app, 'Indexed 3 sessions', 'done');
    await statusUpdate(app, 'Indexing 4 of 9…', 'progress');
    const line = sidebarFooter(page).getByText('Indexing 4 of 9…', { exact: true });
    await expect(line).toBeVisible();
    await expect(sidebarFooter(page).getByText('Indexed 3 sessions')).toHaveCount(0);
    // The done message's linger was cancelled with it.
    await page.clock.fastForward(10_000);
    await expect(line).toBeVisible();
  });

  test('an empty message clears the line at once', async ({ page, app }) => {
    await statusUpdate(app, 'Indexing 4 of 9…', 'progress');
    await expect(sidebarFooter(page).getByText('Indexing 4 of 9…')).toBeVisible();
    await statusUpdate(app, '', '');
    await expect(sidebarFooter(page).getByText('Indexing 4 of 9…')).toHaveCount(0);
  });
});

test.describe('quota gauges', () => {
  test('show the usage fetched at launch, with the full label and reset in the tooltip', async ({ page }) => {
    const session = gauge(page, 'Current session: 42% — resets 6pm (UTC)');
    const week = gauge(page, 'Week (all models): 67% — resets Jun 12 at 9am (UTC)');
    await expect(session).toBeVisible();
    await expect(session).toHaveText('5h42%');
    await expect(week).toHaveText('Week67%');
  });

  test('colour from 60% and from 80%, and never draw less than 1%', async ({ page, app }) => {
    await setHostStub(app, 'usage', usageAt(0, 59));
    await page.reload();
    const empty = gauge(page, 'Current session: 0% — resets 6pm (UTC)');
    const below = gauge(page, 'Week (all models): 59% — resets Jun 12 at 9am (UTC)');
    await expect(empty).toBeVisible();
    expect(await gaugeFill(empty).evaluate(el => (el as HTMLElement).style.width)).toBe('1%');
    await expect(gaugeFill(empty)).toHaveClass('quota-fill');
    await expect(gaugeFill(below)).toHaveClass('quota-fill');

    await setHostStub(app, 'usage', usageAt(60, 80));
    await page.reload();
    const mid = gauge(page, 'Current session: 60% — resets 6pm (UTC)');
    const high = gauge(page, 'Week (all models): 80% — resets Jun 12 at 9am (UTC)');
    await expect(gaugeFill(mid)).toHaveClass('quota-fill quota-mid');
    await expect(gaugeFill(high)).toHaveClass('quota-fill quota-high');
    expect(await gaugeFill(high).evaluate(el => (el as HTMLElement).style.width)).toBe('80%');
  });

  test.describe('without usage', () => {
    test.use({ stubs: { usage: null } });

    test('are hidden when there are no windows', async ({ page }) => {
      await expect(sidebarFooter(page).getByText('5h', { exact: true })).toHaveCount(0);
      await expect(sidebarFooter(page).getByText(/%$/)).toHaveCount(0);
    });
  });

  test.describe('over time', () => {
    test.use({ fakeTimers: true });

    test('are fetched again every five minutes', async ({ page, app }) => {
      await expect(gauge(page, 'Current session: 42% — resets 6pm (UTC)')).toBeVisible();
      await setHostStub(app, 'usage', usageAt(85, 90));
      const before = (await hostStubCalls(app)).getUsage;

      await page.clock.fastForward(USAGE_POLL_MS - 10_000);
      expect((await hostStubCalls(app)).getUsage).toBe(before);
      await page.clock.fastForward(10_000);
      await expect(gauge(page, 'Current session: 85% — resets 6pm (UTC)')).toBeVisible();
      expect((await hostStubCalls(app)).getUsage).toBe(before + 1);
    });

    test('keep what they show when a fetch fails', async ({ page, app }) => {
      const session = gauge(page, 'Current session: 42% — resets 6pm (UTC)');
      await expect(session).toBeVisible();
      await setHostStub(app, 'usageFails', true);
      const before = (await hostStubCalls(app)).getUsage;
      await page.clock.fastForward(USAGE_POLL_MS);
      await expect.poll(async () => (await hostStubCalls(app)).getUsage).toBe(before + 1);
      await expect(session).toBeVisible();
    });

    test('hide when a later fetch has no windows', async ({ page, app }) => {
      const session = gauge(page, 'Current session: 42% — resets 6pm (UTC)');
      await expect(session).toBeVisible();
      await setHostStub(app, 'usage', null);
      await page.clock.fastForward(USAGE_POLL_MS);
      await expect(session).toBeHidden();
    });
  });

  test.describe('and Patch', () => {
    test.use({ fixture: emptyFixture(), stubs: { usage: usageAt(12, 100) } });

    test('reads the same usage, without fetching it again', async ({ page, app }) => {
      await expect(page.getByText('We’ve hit the limit. I’ll nap until Jun 12 at 9am (UTC).')).toBeVisible();
      await expect(gauge(page, 'Week (all models): 100% — resets Jun 12 at 9am (UTC)')).toBeVisible();
      // The usage endpoint rate-limits, so Patch must not ask for its own copy.
      // (The launch reload means the count at boot is one or two, hence a
      // delta past Patch's gather timeout rather than an absolute number.)
      const fetched = (await hostStubCalls(app)).getUsage;
      await page.waitForTimeout(2_000);
      expect((await hostStubCalls(app)).getUsage).toBe(fetched);
    });
  });
});

test.describe('update notice', () => {
  test('is quiet when there is no update', async ({ page }) => {
    await expect(sidebarFooter(page).getByText(/is available$/)).toHaveCount(0);
    await expect(noticeButton(page, 'Install')).toHaveCount(0);
  });

  test('appears when main announces a new version', async ({ page, app }) => {
    await pushEvent(app, EVENT.updateAvailable, UPDATE);
    await expect(sidebarFooter(page).getByText('Version 9.1.0 is available', { exact: true })).toBeVisible();
    await expect(noticeButton(page, 'Install')).toHaveAttribute('title', 'Download, replace this app and restart');
  });

  test.describe('found before launch', () => {
    test.use({ stubs: { update: UPDATE } });

    test('is shown from the start', async ({ page }) => {
      await expect(sidebarFooter(page).getByText('Version 9.1.0 is available', { exact: true })).toBeVisible();
      await expect(noticeButton(page, 'Install')).toBeVisible();
    });

    test('installs straight away when nothing is running', async ({ page, app }) => {
      let asked = false;
      page.on('dialog', dialog => { asked = true; void dialog.dismiss(); });
      await noticeButton(page, 'Install').click();
      await expect(noticeButton(page, 'Installing…')).toBeDisabled();
      expect((await hostStubCalls(app)).installUpdate).toBe(1);
      expect(asked).toBe(false);
    });

    test('asks first when sessions are running', async ({ page, app, home }) => {
      await openSession(page, home, LABEL.loginFix, S.loginFix);

      const declined = answerConfirm(page, false);
      await noticeButton(page, 'Install').click();
      expect(await declined).toBe('Restarting to update stops 1 running session. Install now?');
      await expect(noticeButton(page, 'Install')).toBeEnabled();
      expect((await hostStubCalls(app)).installUpdate).toBe(0);

      const accepted = answerConfirm(page, true);
      await noticeButton(page, 'Install').click();
      await accepted;
      await expect(noticeButton(page, 'Installing…')).toBeDisabled();
      expect((await hostStubCalls(app)).installUpdate).toBe(1);
    });

    test('dismisses that version only, until the window reloads', async ({ page, app }) => {
      const notice = sidebarFooter(page).getByText(/^Version [\d.]+ is available$/);
      await noticeButton(page, 'Dismiss').click();
      await expect(notice).toBeHidden();

      await pushEvent(app, EVENT.updateAvailable, UPDATE);
      await expect(notice).toBeHidden();

      await pushEvent(app, EVENT.updateAvailable, { ...UPDATE, version: '9.2.0' });
      await expect(sidebarFooter(page).getByText('Version 9.2.0 is available', { exact: true })).toBeVisible();

      // Held in memory only: a fresh window offers the dismissed version again.
      await page.reload();
      await expect(sidebarFooter(page).getByText('Version 9.1.0 is available', { exact: true })).toBeVisible();
    });
  });

  test.describe('when the install fails', () => {
    test.use({ stubs: { update: UPDATE, installUpdate: false } });

    test('says so and offers a retry', async ({ page, app }) => {
      await noticeButton(page, 'Install').click();
      await expect(sidebarFooter(page).getByText('Update failed', { exact: true })).toBeVisible();
      await expect(noticeButton(page, 'Retry')).toBeEnabled();

      await noticeButton(page, 'Retry').click();
      await expect.poll(async () => (await hostStubCalls(app)).installUpdate).toBe(2);
      await expect(noticeButton(page, 'Retry')).toBeEnabled();
    });
  });

  test.describe('when the app cannot replace itself', () => {
    test.use({ stubs: { update: { ...UPDATE, installable: false } } });

    test('links to the release page instead', async ({ page, app }) => {
      const view = noticeButton(page, 'View');
      await expect(view).toHaveAttribute('title', 'Open the release page');
      await view.click();
      await expect.poll(() => openedExternally(app)).toContain(UPDATE.pageUrl);
      expect((await hostStubCalls(app)).installUpdate).toBe(0);
    });
  });
});

forEachAppearance(() => {
  test.describe('busy', () => {
    test.use({ stubs: { update: UPDATE, usage: usageAt(63, 86) } });

    test('footer with an update, activity and low quota', async ({ page, app }) => {
      await statusUpdate(app, 'Indexing 4 of 9…', 'progress');
      await expect(sidebarFooter(page).getByText('Indexing 4 of 9…')).toBeVisible();
      await expect(sidebarFooter(page).getByText('Version 9.1.0 is available')).toBeVisible();
      await expectScreen(page, 'footer-busy');
    });
  });
});
