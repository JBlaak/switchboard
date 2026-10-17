/**
 * The session list, item by item of its port (#63): the order and the
 * sections, the anchoring, the truncation, what survives a redraw, the
 * reflow, what a row shows, what clicking it does, and renaming.
 *
 * Written against the vanilla list first, so the React one has to behave the
 * same way to pass. The screenshots of the plain list, its filters and the
 * older sessions are in `sidebar.spec.ts`; the ones here add the row states
 * and an open slug group.
 */
import { test, expect, forEachAppearance } from '../support/test';
import {
  dialog, expectScreen, openRemoteSession, openSession, rowButton, searchBox, sessionRow, sidebar,
  sidebarFilter, terminalHeader, terminalStatus,
} from '../support/app';
import { fakeClaude, launchedKeys, waitForNewLaunch } from '../support/fake-cli';
import { daysAgo, hoursAgo, minutesAgo, sessionId } from '../support/fixture-home';
import { failStopSession, openedExternally, windowPosition } from '../support/main-process';
import { answerDialogs, dialogsAsked } from '../support/native-dialogs';
import { askQuestions } from '../support/questions';
import {
  allowMotion, expectInOrder, expectRowsInOrder, failInvoke, listScroller, readMotion,
  redraw, renameInput, rowNode, sectionOf, sessionItem, startMotionRecorder, storedSession, tagRow,
} from '../support/session-list';
import { LABEL, P, S, standardFixture } from '../fixtures/standard';
import type { Locator, Page } from '@playwright/test';
import type { FixtureHome, FixtureSpec } from '../support/fixture-home';

const BILLING_PLAN = 'Plan how to move billing out of the monolith';
const BILLING_STEP_1 = 'Implement the plan: extract the invoice model';
const BILLING_STEP_2 = 'Implement the plan: move the payment webhooks';

/** The terminal's keyboard target: xterm's hidden textarea. */
function terminalInput(page: Page) {
  return page.getByRole('textbox', { name: 'Terminal input' });
}

/** A fixture of `count` recent sessions in one project, newest first, for the long-list cases. */
function manySessions(count: number, settings: Record<string, unknown> = {}): FixtureSpec {
  return {
    projects: [{
      path: 'Development/big',
      sessions: Array.from({ length: count }, (_, i) => ({
        id: sessionId('many-' + i),
        prompt: `Long list session ${String(i + 1).padStart(2, '0')}`,
        at: minutesAgo(10 + i * 5),
      })),
    }],
    settings: { visibleSessionCount: 100, ...settings },
  };
}

/**
 * Double-click a row's label to rename it, with its session already open.
 *
 * Open first, because the double-click's own clicks open the session too: on a
 * session that is not open yet, the terminal it launches takes the focus a
 * moment later, and the input saves and closes as it loses it.
 */
async function startMouseRename(page: Page, home: FixtureHome, label: string, id: string): Promise<void> {
  await openSession(page, home, label, id);
  await sessionRow(page, label).dblclick();
}

/** A row button the stylesheet may be hiding (`display: none`), which `rowButton` would not find. */
function hiddenRowButton(row: Locator, name: string): Locator {
  return row.locator('xpath=ancestor::*[.//button][1]').getByRole('button', { name, exact: true, includeHidden: true });
}

/** A short list, so there is space left under it. */
function shortList(): FixtureSpec {
  return {
    projects: [{
      path: P.notes,
      sessions: [
        { id: sessionId('short-1'), prompt: 'A short list, first', at: minutesAgo(5) },
        { id: sessionId('short-2'), prompt: 'A short list, second', at: minutesAgo(15) },
      ],
    }],
  };
}

/** Start a plain terminal in a project, the way main lists one: by its PTY. */
async function startPlainTerminal(page: Page, projectPath: string): Promise<string> {
  return await page.evaluate(async (projectPath) => {
    const id = crypto.randomUUID();
    await window.api.openTerminal(id, projectPath, true, { type: 'terminal' });
    return id;
  }, projectPath);
}

// ── Order and sections ──

test.describe('order', () => {
  test('needs input, ready, working, pinned, then recent, newest first within each', async ({ page, app, home }) => {
    const login = await openSession(page, home, LABEL.loginFix, S.loginFix);
    const charts = await openSession(page, home, LABEL.chartsDarkMode, S.chartsDarkMode);
    await openSession(page, home, LABEL.worktreeTry, S.worktreeTry);
    await charts.status({ state: 'working' });
    await login.status({ state: 'blocked', kind: 'permission' });
    await redraw(page, app, S.bumpDeps);

    expect(await sectionOf(page, LABEL.loginFix)).toBe('Needs input');
    expect(await sectionOf(page, LABEL.worktreeTry)).toBe('Ready');
    expect(await sectionOf(page, LABEL.chartsDarkMode)).toBe('Working');
    expect(await sectionOf(page, LABEL.releaseNotes)).toBe('Pinned');
    expect(await sectionOf(page, LABEL.billingGroup)).toBe('Recent');
    await expectInOrder(page, [
      'Needs input', LABEL.loginFix, 'Ready', LABEL.worktreeTry, 'Working', LABEL.chartsDarkMode,
      'Pinned', LABEL.releaseNotes, 'Recent', LABEL.billingGroup, LABEL.remoteApi, LABEL.parserExperiment,
    ]);
  });

  test.describe('the same slug in two projects', () => {
    test.use({
      fixture: {
        projects: ['Development/one', 'Development/two'].map((path, p) => ({
          path,
          sessions: [0, 1].map(i => ({
            id: sessionId(`slug-${p}-${i}`),
            prompt: `Shared plan, project ${p + 1}, step ${i + 1}`,
            at: hoursAgo(1 + p * 2 + i),
            slug: 'shared-quiet-heron',
          })),
        })),
      },
    });

    test('folds into one group per project', async ({ page }) => {
      await expect(sidebar(page).getByText('2 sessions', { exact: true })).toHaveCount(2);
      // Each group is named after its newest session.
      await expect(sessionRow(page, 'Shared plan, project 1, step 1').first()).toBeVisible();
      await expect(sessionRow(page, 'Shared plan, project 2, step 1').first()).toBeVisible();
    });
  });
});

// ── Anchoring ──

test.describe('anchoring', () => {
  test('the open session keeps its slot while the rest reorders, until a re-sort', async ({ page, app, home }) => {
    const charts = await openSession(page, home, LABEL.chartsDarkMode, S.chartsDarkMode);
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await redraw(page, app, S.bumpDeps);
    await expectInOrder(page, ['Ready', LABEL.loginFix, LABEL.chartsDarkMode]);

    // A new turn makes charts the newest of the two; the open session stays put.
    await charts.userTurn('One more thing about the legend');
    await expect(sessionItem(page, S.chartsDarkMode).getByText(/^just now/)).toBeVisible();
    await expectInOrder(page, ['Ready', LABEL.loginFix, LABEL.chartsDarkMode]);

    // A filter is the user's own re-sort: now it moves.
    await sidebarFilter(page, 'today').click();
    await sidebarFilter(page, 'today').click();
    await expectInOrder(page, ['Ready', LABEL.chartsDarkMode, LABEL.loginFix]);
  });

  test('a busy↔idle flip moves the open row between sections without a re-sort', async ({ page, app, home }) => {
    const login = await openSession(page, home, LABEL.loginFix, S.loginFix);
    await redraw(page, app, S.bumpDeps);
    expect(await sectionOf(page, LABEL.loginFix)).toBe('Ready');

    await login.status({ state: 'working' });
    await expect.poll(() => sectionOf(page, LABEL.loginFix)).toBe('Working');
    await login.status({ state: 'idle' });
    await expect.poll(() => sectionOf(page, LABEL.loginFix)).toBe('Ready');
  });
});

// ── Truncation ──

test.describe('truncation', () => {
  test('rows older than the age limit fold behind "+ N older", pinned and remote ones stay', async ({ page }) => {
    await expect(sidebar(page).getByText('+ 3 older', { exact: true })).toBeVisible();
    await expect(sessionRow(page, LABEL.meetingNotes)).toBeHidden();
    await expect(sessionRow(page, LABEL.flakyE2e)).toBeHidden();
    await expect(sessionRow(page, LABEL.bumpDeps)).toBeHidden();
    // Pinned five days ago, and a remote last opened three hours ago: both stay.
    await expect(sessionRow(page, LABEL.releaseNotes)).toBeVisible();
    await expect(sessionRow(page, LABEL.remoteApi)).toBeVisible();
  });

  test.describe('with a visible count of two', () => {
    test.use({ fixture: { ...standardFixture(), settings: { visibleSessionCount: 2 } } });

    test('rows beyond the count fold too', async ({ page }) => {
      await expect(sidebar(page).getByText('+ 7 older', { exact: true })).toBeVisible();
      await expect(sessionRow(page, LABEL.loginFix)).toBeVisible();
      await expect(sessionRow(page, LABEL.worktreeTry)).toBeHidden();
      await expect(sessionRow(page, LABEL.releaseNotes)).toBeVisible();
      await expect(sessionRow(page, LABEL.remoteApi)).toBeVisible();
    });
  });

  test('the open session always shows', async ({ page, app, home }) => {
    await sidebar(page).getByText('+ 3 older', { exact: true }).click();
    const meeting = await openSession(page, home, LABEL.meetingNotes, S.meetingNotes);
    await meeting.exit(0);
    await expect(terminalStatus(page)).toHaveText('Stopped');
    await sidebar(page).getByText('- hide older', { exact: true }).click();
    await redraw(page, app, S.bumpDeps);

    await expect(sessionRow(page, LABEL.meetingNotes)).toBeVisible();
    await expect(sidebar(page).getByText('+ 2 older', { exact: true })).toBeVisible();
  });

  test.describe('when every row is old', () => {
    test.use({
      fixture: {
        projects: [{
          path: P.notes,
          sessions: [
            { id: sessionId('old-1'), prompt: 'An old session', at: daysAgo(8) },
            { id: sessionId('old-2'), prompt: 'An older session', at: daysAgo(9) },
          ],
        }],
      },
    });

    test('all of them show rather than an empty list', async ({ page }) => {
      await expect(sessionRow(page, 'An old session')).toBeVisible();
      await expect(sessionRow(page, 'An older session')).toBeVisible();
      await expect(sidebar(page).getByText(/^\+ \d+ older$/)).toHaveCount(0);
    });
  });

  test('nothing folds while searching', async ({ page }) => {
    await searchBox(page).fill('notes');
    await expect(sessionRow(page, LABEL.meetingNotes)).toBeVisible();
    await expect(sidebar(page).getByText(/^\+ \d+ older$/)).toHaveCount(0);
  });
});

// ── What a redraw leaves alone ──

test.describe('a redraw keeps', () => {
  test.describe('on a long list', () => {
    test.use({ fixture: manySessions(40) });

    test('the scroll position', async ({ page, app }) => {
      await listScroller(page).evaluate(el => { el.scrollTop = 300; });
      await redraw(page, app, sessionId('many-39'));
      expect(await listScroller(page).evaluate(el => el.scrollTop)).toBe(300);
    });
  });

  test('an open rename input, with what is typed in it', async ({ page, app, home }) => {
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    // Settle the row in its section first: a row that moves (here, from Recent
    // to Ready) is taken out and put back, and the input loses its focus.
    await redraw(page, app, S.bumpDeps);
    await sessionRow(page, LABEL.loginFix).dblclick();
    const input = renameInput(page);
    await input.fill('Half-typed name');
    await redraw(page, app, S.flakyE2e);
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('Half-typed name');
  });

  test('an expanded slug group', async ({ page, app }) => {
    await sessionRow(page, LABEL.billingGroup).first().click();
    await expect(sessionRow(page, BILLING_STEP_1)).toBeVisible();
    await redraw(page, app, S.bumpDeps);
    await expect(sessionRow(page, BILLING_STEP_1)).toBeVisible();
  });

  test('the expanded older list and its label', async ({ page, app }) => {
    await sidebar(page).getByText('+ 3 older', { exact: true }).click();
    await redraw(page, app, S.flakyE2e);
    await expect(sidebar(page).getByText('- hide older', { exact: true })).toBeVisible();
    await expect(sessionRow(page, LABEL.meetingNotes)).toBeVisible();
  });

  test('a group expanded through its "+ N more"', async ({ page, app, home }) => {
    await sessionRow(page, LABEL.billingGroup).first().click();
    await openSession(page, home, BILLING_STEP_1, S.billingStep1);
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await redraw(page, app, S.bumpDeps);
    // Collapse it again, and open it through the toggle instead.
    await sidebar(page).getByText('3 sessions', { exact: true }).click();
    await expect(sessionRow(page, BILLING_PLAN)).toBeHidden();
    await sidebar(page).getByText('+ 2 more', { exact: true }).dispatchEvent('click');
    await expect(sessionRow(page, BILLING_PLAN)).toBeVisible();
    await redraw(page, app, S.flakyE2e);
    await expect(sessionRow(page, BILLING_PLAN)).toBeVisible();
  });

  test('the keyboard cursor', async ({ page, app, home }) => {
    await page.keyboard.press('Meta+l');
    await page.keyboard.press('ArrowDown');
    await redraw(page, app, S.bumpDeps);
    // The cursor sat on the second row (the first under Recent); Enter opens it.
    await page.keyboard.press('Enter');
    await fakeClaude(home, S.loginFix).launched();
  });

  test.describe('on a paused clock', () => {
    test.use({ fakeTimers: true });

    test('a row in the middle of its exit', async ({ page }) => {
      await allowMotion(page);
      await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000);
      await tagRow(page, S.chartsDarkMode, 'leaving');
      const row = sessionRow(page, LABEL.chartsDarkMode);
      await row.hover();
      await rowButton(row, 'Archive').click();
      await page.clock.runFor(400);
      const before = await rowNode(page, S.chartsDarkMode);
      expect(before).toMatchObject({ tag: 'leaving', leaving: true });
      expect(before!.transform).toContain('translate3d');

      // A re-sort lands mid-slide: the row keeps its node and its slide.
      await sidebarFilter(page, 'today').click();
      await sidebarFilter(page, 'today').click();
      const during = await rowNode(page, S.chartsDarkMode);
      expect(during).toMatchObject({ tag: 'leaving', leaving: true, transform: before!.transform });

      await page.clock.runFor(3000);
      await page.clock.resume();
      await expect(sessionItem(page, S.chartsDarkMode)).toHaveCount(0);
    });
  });
});

// ── Reflow ──

test.describe('reflow', () => {
  test('top-level entries glide to their new place; rows inside a group ride along', async ({ page }) => {
    await sessionRow(page, LABEL.billingGroup).first().click();
    await expect(sessionRow(page, BILLING_STEP_1)).toBeVisible();
    await allowMotion(page);
    await startMotionRecorder(page);

    // Pinning the parser row lifts it above everything else that is recent.
    const parser = sessionRow(page, LABEL.parserExperiment);
    await parser.hover();
    await sessionItem(page, S.parserExperiment).getByTestId('session-pin').click();
    await expect.poll(() => sectionOf(page, LABEL.parserExperiment)).toBe('Pinned');

    await expect.poll(async () => (await readMotion(page)).moved).toEqual(expect.arrayContaining([
      S.parserExperiment, S.loginFix, expect.stringMatching(/^slug-/),
    ]));
    const { moved } = await readMotion(page);
    for (const nested of [S.billingPlan, S.billingStep1, S.billingStep2]) expect(moved).not.toContain(nested);
  });

  test('a new row fades in', async ({ page, home }) => {
    await allowMotion(page);
    await startMotionRecorder(page);
    const before = launchedKeys(home);
    await page.getByRole('button', { name: 'New session', exact: true }).click();
    await dialog(page, 'New Session').getByText(P.webDashboard, { exact: true }).click();
    const claude = await waitForNewLaunch(home, 'claude', before);
    await expect.poll(async () => (await readMotion(page)).faded).toContain(claude.key);
  });

  test('a removed row leaves a fading ghost', async ({ page }) => {
    await allowMotion(page);
    await startMotionRecorder(page);
    await searchBox(page).fill('login');
    await expect(sessionRow(page, LABEL.chartsDarkMode)).toHaveCount(0);
    await expect.poll(async () => (await readMotion(page)).ghosts).toBeGreaterThan(0);
  });

  test.describe('on a long list', () => {
    test.use({ fixture: manySessions(30) });

    test('nothing moves when more than 12 rows leave at once', async ({ page }) => {
      await allowMotion(page);
      await startMotionRecorder(page);
      await searchBox(page).fill('"session 01"');
      await expect(sessionRow(page, 'Long list session 02')).toHaveCount(0);
      await page.waitForTimeout(500);
      expect(await readMotion(page)).toMatchObject({ moved: [], ghosts: 0 });
    });
  });

  test('nothing moves on the first render', async ({ page }) => {
    await allowMotion(page);
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { __firstRender: string[] }).__firstRender = seen;
      new MutationObserver((mutations) => {
        for (const m of mutations) {
          const el = m.target as HTMLElement;
          if (el.closest?.('#sidebar-content') && (el.style.transform || el.style.opacity)) seen.push(el.id);
        }
      }).observe(document, { subtree: true, attributes: true, attributeFilter: ['style'] });
    });
    await page.reload();
    await expect(sessionRow(page, LABEL.loginFix)).toBeVisible();
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as unknown as { __firstRender: string[] }).__firstRender)).toEqual([]);
  });

  test('nothing moves while the sidebar is collapsed', async ({ page, app }) => {
    await allowMotion(page);
    await startMotionRecorder(page);
    await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
    // Pinning from elsewhere reorders the list behind the rail.
    await page.evaluate((id) => window.api.toggleStar(id), S.parserExperiment);
    await redraw(page, app, S.bumpDeps);
    await page.waitForTimeout(500);
    expect(await readMotion(page)).toMatchObject({ moved: [], ghosts: 0 });
  });

  test.describe('on a paused clock', () => {
    test.use({ fakeTimers: true });

    test('a row caught mid-glide keeps its node and heads for its newest place', async ({ page }) => {
      await allowMotion(page);
      await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000);
      await tagRow(page, S.parserExperiment, 'parser');
      const pin = sessionItem(page, S.parserExperiment).getByTestId('session-pin');

      await sessionRow(page, LABEL.parserExperiment).hover();
      await pin.click();
      await expect.poll(() => sectionOf(page, LABEL.parserExperiment)).toBe('Pinned');
      await page.clock.runFor(50);
      expect((await rowNode(page, S.parserExperiment))!.transform).toContain('translate3d');

      // Unpinned again mid-glide: the same node turns round. Dispatched, since
      // a node caught mid-glide is never "stable" enough for a real click.
      await pin.dispatchEvent('click');
      await expect.poll(() => sectionOf(page, LABEL.parserExperiment)).toBe('Recent');
      await page.clock.runFor(50);
      expect(await rowNode(page, S.parserExperiment)).toMatchObject({ tag: 'parser' });

      await page.clock.runFor(3000);
      expect(await rowNode(page, S.parserExperiment)).toMatchObject({ tag: 'parser', transform: '' });
      await page.clock.resume();
    });
  });
});

// ── Focus ──

test.describe('after a redraw', () => {
  test('the terminal takes the keyboard back', async ({ page, app, home }) => {
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(terminalInput(page)).not.toBeFocused();
    await redraw(page, app, S.bumpDeps);
    await expect(terminalInput(page)).toBeFocused();
  });

  test('but not from the search box', async ({ page, app, home }) => {
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await searchBox(page).focus();
    await redraw(page, app, S.bumpDeps);
    await expect(searchBox(page)).toBeFocused();
  });

  test('nor from the list itself', async ({ page, app, home }) => {
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await page.keyboard.press('Meta+l');
    await expect(terminalInput(page)).not.toBeFocused();
    await redraw(page, app, S.bumpDeps);
    await expect(terminalInput(page)).not.toBeFocused();
    await expect(sidebar(page).locator(':focus')).toHaveCount(1);
  });

  test('nor from the question panel', async ({ page, app, home }) => {
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await askQuestions(home, S.loginFix, [{ question: 'Which way?', options: [{ label: 'Left' }, { label: 'Right' }] }]);
    const panel = page.getByRole('region', { name: 'Questions from Claude' });
    await expect(panel.getByRole('heading', { name: 'Which way?' })).toBeVisible();
    await panel.getByRole('button', { name: /Left/ }).focus();
    await redraw(page, app, S.bumpDeps);
    await expect(terminalInput(page)).not.toBeFocused();
    await expect(panel.getByRole('button', { name: /Left/ })).toBeFocused();
  });
});

// ── What a row shows ──

test.describe('row content', () => {
  test('a pin on every row, filled when pinned', async ({ page }) => {
    await expect(sessionItem(page, S.releaseNotes).getByTestId('session-pin')).toHaveClass(/\bpinned\b/);
    await expect(sessionItem(page, S.loginFix).getByTestId('session-pin')).not.toHaveClass(/\bpinned\b/);
  });

  test('a status dot that shows a running session', async ({ page, home }) => {
    const dot = sessionItem(page, S.loginFix).getByTestId('session-status-dot');
    await expect(dot).not.toHaveClass(/\brunning\b/);
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await expect(dot).toHaveClass(/\brunning\b/);
  });

  test('up to two PR chips, newest first, and "+N" naming the rest', async ({ page }) => {
    const row = sessionItem(page, S.loginFix);
    await expect(row.getByText('#1320', { exact: true })).toBeVisible();
    await expect(row.getByText('#1312', { exact: true })).toBeVisible();
    await expect(row.getByText('#1309', { exact: true })).toHaveCount(0);
    await expect(row.getByText('+1', { exact: true })).toHaveAttribute('title', /#1309/);
  });

  test('"Asking N questions" while the session asks', async ({ page, home }) => {
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await askQuestions(home, S.loginFix, [
      { question: 'One?', options: [{ label: 'Yes' }, { label: 'No' }] },
      { question: 'Two?', options: [{ label: 'Yes' }, { label: 'No' }] },
    ]);
    await expect(sessionItem(page, S.loginFix).getByText('Asking 2 questions', { exact: true })).toBeVisible();
  });

  test('a subagents badge whose tooltip lists the agents', async ({ page, home }) => {
    const claude = await openSession(page, home, LABEL.loginFix, S.loginFix);
    await claude.status({ state: 'working' });
    await claude.status({ state: 'working', id: 'agents/1', title: 'Explore the redirect handler' });
    await claude.status({ state: 'working', id: 'agents/2', title: 'Read the session middleware' });
    const badge = sessionItem(page, S.loginFix).getByTitle(/^2 agents working/);
    await expect(badge).toHaveText('2');
    await expect(badge).toHaveAttribute('title',
      '2 agents working\n• Explore the redirect handler\n• Read the session middleware');

    await claude.status({ state: 'clear', id: 'agents/2' });
    await expect(sessionItem(page, S.loginFix).getByTitle(/^1 agent working/)).toHaveText('1');
  });

  test('the project and the time and message count, but no short id', async ({ page }) => {
    const row = sessionItem(page, S.loginFix);
    await expect(row.getByText(P.acmeApi, { exact: true })).toBeVisible();
    await expect(row.getByText('20m ago · 12 msgs', { exact: true })).toBeVisible();
    await expect(row.getByText(S.loginFix.split('-')[0], { exact: true })).toHaveCount(0);
    await expect(sessionItem(page, S.parserExperiment).getByText('Development/old-parser ⎇ streaming', { exact: true }))
      .toBeVisible();
  });

  test.describe('on a running clock', () => {
    test.use({ fakeTimers: true });

    test('the relative time is refreshed every 30 seconds', async ({ page }) => {
      const row = sessionItem(page, S.loginFix);
      await expect(row.getByText('20m ago · 12 msgs', { exact: true })).toBeVisible();
      await page.clock.fastForward(5 * 60_000);
      await expect(row.getByText('25m ago · 12 msgs', { exact: true })).toBeVisible();
    });
  });

  test.describe('with a remote terminal', () => {
    test.use({
      fixture: {
        ...standardFixture(),
        remotes: [{
          user: 'joris', host: 'buildbox.local', dir: '~/apps/api',
          sessions: [
            { id: S.remoteApi, kind: 'claude', created: daysAgo(2), lastOpened: hoursAgo(3) },
            { id: sessionId('remote-shell'), kind: 'shell', created: daysAgo(2), lastOpened: hoursAgo(4) },
          ],
        }],
      },
    });

    test('a terminal badge on terminals, local and remote', async ({ page, app, home }) => {
      await expect(sessionItem(page, sessionId('remote-shell')).getByTestId('terminal-badge')).toHaveCount(1);
      await expect(sessionItem(page, S.remoteApi).getByTestId('terminal-badge')).toHaveCount(0);
      await expect(sessionItem(page, S.loginFix).getByTestId('terminal-badge')).toHaveCount(0);

      const terminal = await startPlainTerminal(page, home.projectPath(P.notes));
      await redraw(page, app, S.bumpDeps);
      await expect(sessionItem(page, terminal).getByTestId('terminal-badge')).toHaveCount(1);
    });
  });
});

test.describe('state classes', () => {
  test('needs-attention, response-ready, cli-busy and the running PTY', async ({ page, home }) => {
    const login = await openSession(page, home, LABEL.loginFix, S.loginFix);
    const row = sessionItem(page, S.loginFix);
    await expect(row).toHaveClass(/\bhas-running-pty\b/);

    await login.status({ state: 'working' });
    await expect(row).toHaveClass(/\bcli-busy\b/);

    // Look at another session, so the answer arrives unread.
    await sessionRow(page, LABEL.chartsDarkMode).click();
    await login.status({ state: 'idle' });
    await expect(row).toHaveClass(/\bresponse-ready\b/);
    await expect(row).not.toHaveClass(/\bcli-busy\b/);

    await login.notify('Claude needs your permission to use Bash');
    await expect(row).toHaveClass(/\bneeds-attention\b/);
  });

  test('archived', async ({ page }) => {
    await sidebarFilter(page, 'archived').click();
    await expect(sessionItem(page, S.graphqlSpike)).toHaveClass(/\barchived-item\b/);
  });

  test('terminal', async ({ page, app, home }) => {
    const terminal = await startPlainTerminal(page, home.projectPath(P.notes));
    await redraw(page, app, S.bumpDeps);
    await expect(sessionItem(page, terminal)).toHaveClass(/\bis-terminal\b/);
    await expect(sessionItem(page, S.loginFix)).not.toHaveClass(/\bis-terminal\b/);
  });

  test('active follows the session on screen', async ({ page, home }) => {
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await expect(sessionItem(page, S.loginFix)).toHaveClass(/\bactive\b/);
    await sessionRow(page, LABEL.chartsDarkMode).click();
    await expect(sessionItem(page, S.chartsDarkMode)).toHaveClass(/\bactive\b/);
    await expect(sessionItem(page, S.loginFix)).not.toHaveClass(/\bactive\b/);
  });
});

test.describe('hover actions', () => {
  // Stop is on every row, but the stylesheet shows it only while the session
  // runs (where it takes the place of resume-with-config).
  test('a Claude session can be stopped, archived and resumed with a config', async ({ page }) => {
    const row = sessionRow(page, LABEL.loginFix);
    await row.hover();
    await expect(hiddenRowButton(row, 'Stop session')).toHaveCount(1);
    await expect(rowButton(row, 'Archive')).toBeVisible();
    await expect(rowButton(row, 'Resume with config')).toBeVisible();
  });

  test('a remote session can be disconnected and archived', async ({ page }) => {
    const row = sessionRow(page, LABEL.remoteApi);
    await row.hover();
    await expect(hiddenRowButton(row, 'Disconnect (keeps running on the remote)')).toHaveCount(1);
    await expect(rowButton(row, 'Archive')).toBeVisible();
    await expect(rowButton(row, 'Resume with config')).toHaveCount(0);
  });

  test('a plain terminal can only be stopped', async ({ page, app, home }) => {
    const terminal = await startPlainTerminal(page, home.projectPath(P.notes));
    await redraw(page, app, S.bumpDeps);
    const item = sessionItem(page, terminal);
    await item.hover();
    await expect(item.getByRole('button', { includeHidden: true })).toHaveCount(1);
    await expect(item.getByRole('button', { name: 'Stop session', exact: true })).toBeVisible();
  });

  test('an archived session offers to unarchive', async ({ page }) => {
    await sidebarFilter(page, 'archived').click();
    const row = sessionRow(page, LABEL.graphqlSpike);
    await row.hover();
    await expect(rowButton(row, 'Unarchive')).toBeVisible();
  });
});

// ── Slug groups ──

test.describe('slug group', () => {
  test('shows the latest name, the project, the count and the date, and an archive-all button', async ({ page }) => {
    const header = sessionRow(page, LABEL.billingGroup).first();
    await expect(header).toBeVisible();
    await expect(sidebar(page).getByText('3 sessions', { exact: true })).toBeVisible();
    const group = header.locator('xpath=ancestor::*[.//button][1]');
    await expect(group.getByText(P.acmeApi, { exact: true })).toBeVisible();
    await expect(group).toContainText('3 sessions 1h ago');
    await expect(rowButton(header, 'Archive all sessions in group')).toHaveCount(1);
  });

  test('puts running sessions first and the rest behind "+ N more"', async ({ page, app, home }) => {
    await sessionRow(page, LABEL.billingGroup).first().click();
    await openSession(page, home, BILLING_PLAN, S.billingPlan);
    await redraw(page, app, S.bumpDeps);
    await expectRowsInOrder(page, [S.billingPlan, S.billingStep2, S.billingStep1]);
    await expect(sidebar(page).getByText('+ 2 more', { exact: true })).toHaveCount(1);
  });

  test('remembers which groups are open across a reload', async ({ page }) => {
    await sessionRow(page, LABEL.billingGroup).first().click();
    await expect(sessionRow(page, BILLING_STEP_1)).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem('expandedSlugs'))).toMatch(/slug-/);
    await page.reload();
    await expect(sessionRow(page, BILLING_STEP_1)).toBeVisible();

    await sessionRow(page, LABEL.billingGroup).first().click();
    await expect(sessionRow(page, BILLING_STEP_1)).toBeHidden();
    expect(await page.evaluate(() => sessionStorage.getItem('expandedSlugs'))).toBe('[]');
    await page.reload();
    await expect(sessionRow(page, LABEL.loginFix)).toBeVisible();
    await expect(sessionRow(page, BILLING_STEP_1)).toBeHidden();
  });

  test('opens again after a redraw when it holds the session on screen', async ({ page, app, home }) => {
    await sessionRow(page, LABEL.billingGroup).first().click();
    await openSession(page, home, BILLING_STEP_1, S.billingStep1);
    await sidebar(page).getByText('3 sessions', { exact: true }).click();
    await expect(sessionRow(page, BILLING_PLAN)).toBeHidden();
    await redraw(page, app, S.bumpDeps);
    await expect(sessionRow(page, BILLING_PLAN)).toBeVisible();
  });
});

test.describe('under a short list', () => {
  test.use({ fixture: shortList() });

  test('the space left runs down to the footer', async ({ page }) => {
    const space = page.getByTestId('sidebar-drag-space');
    const box = (await space.boundingBox())!;
    const footer = (await page.getByTestId('sidebar-footer').boundingBox())!;
    expect(box.height).toBeGreaterThan(100);
    // It runs down to the footer, less the list's bottom padding.
    expect(Math.abs(box.y + box.height - footer.y)).toBeLessThanOrEqual(12);
    // Not a CSS drag region: macOS would swallow the click that puts the session away.
    expect(await space.evaluate(el => getComputedStyle(el).getPropertyValue('-webkit-app-region'))).not.toBe('drag');
  });

  test('a drag in the empty space moves the window and keeps the session open', async ({ page, app, home }) => {
    await openSession(page, home, 'A short list, first', sessionId('short-1'));
    const before = await windowPosition(app);
    // Dispatched by hand rather than with page.mouse: a real cursor's screenX
    // stays put as the window moves under it, a synthesized one's does not.
    await page.getByTestId('sidebar-drag-space').evaluate((space) => {
      const at = (type: string, screenX: number, screenY: number) =>
        space.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 7, screenX, screenY }));
      at('pointerdown', 500, 500);
      at('pointermove', 502, 501);
      at('pointermove', 520, 510);
      at('pointermove', 540, 530);
      at('pointerup', 540, 530);
    });
    await expect.poll(() => windowPosition(app)).toEqual([before[0]! + 40, before[1]! + 30]);
    // A drag ends in no click, so the session stays on screen.
    await page.getByTestId('sidebar-drag-space').dispatchEvent('click');
    await expect(terminalHeader(page)).toBeVisible();
  });

  test('a press that barely moves is still a click', async ({ page, home }) => {
    await openSession(page, home, 'A short list, first', sessionId('short-1'));
    const box = (await page.getByTestId('sidebar-drag-space').boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 2, y + 1);
    await page.mouse.up();
    await expect(page.getByTestId('empty-screen')).toBeVisible();
  });

  test('a click in the empty space puts the session away, a click on a control does not', async ({ page, home }) => {
    await openSession(page, home, 'A short list, first', sessionId('short-1'));
    await sessionRow(page, 'A short list, second').hover();
    await sessionItem(page, sessionId('short-2')).getByTestId('session-pin').click();
    await expect(terminalHeader(page)).toBeVisible();
    await page.getByTestId('sidebar-drag-space').click();
    await expect(page.getByTestId('empty-screen')).toBeVisible();
    await expect(terminalHeader(page)).toBeHidden();
    await expect(sessionItem(page, sessionId('short-1'))).not.toHaveClass(/\bactive\b/);
  });
});

// ── Row actions ──

test.describe('clicking a row', () => {
  test('opens its session', async ({ page, home }) => {
    await sessionRow(page, LABEL.chartsDarkMode).click();
    await fakeClaude(home, S.chartsDarkMode).launched();
    await expect(terminalHeader(page).getByText(LABEL.chartsDarkMode)).toBeVisible();
  });

  test.describe('on a paused clock', () => {
    test.use({ fakeTimers: true });

    test('does nothing while the row is leaving', async ({ page, home }) => {
      await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000);
      const row = sessionRow(page, LABEL.chartsDarkMode);
      await row.hover();
      await rowButton(row, 'Archive').click();
      await row.click();
      await page.waitForTimeout(1000);
      expect(fakeClaude(home, S.chartsDarkMode).launches()).toHaveLength(0);
      await page.clock.resume();
      await expect(sessionItem(page, S.chartsDarkMode)).toHaveCount(0);
    });
  });
});

test.describe('pin', () => {
  test('pinning moves the row into Pinned once main has stored it', async ({ page }) => {
    await sessionRow(page, LABEL.chartsDarkMode).hover();
    await sessionItem(page, S.chartsDarkMode).getByTestId('session-pin').click();
    await expect.poll(() => sectionOf(page, LABEL.chartsDarkMode)).toBe('Pinned');
    expect(await storedSession(page, S.chartsDarkMode)).toMatchObject({ starred: 1 });
    await expect(sessionItem(page, S.chartsDarkMode).getByTestId('session-pin')).toHaveClass(/\bpinned\b/);
  });

  test('unpinning sends an old row back behind "+ N older"', async ({ page }) => {
    await sessionRow(page, LABEL.releaseNotes).hover();
    await sessionItem(page, S.releaseNotes).getByTestId('session-pin').click();
    await expect(sidebar(page).getByText('+ 4 older', { exact: true })).toBeVisible();
    await expect(sessionRow(page, LABEL.releaseNotes)).toBeHidden();
    expect(await storedSession(page, S.releaseNotes)).toMatchObject({ starred: 0 });
  });
});

test.describe('stop', () => {
  test('asks first, and leaves the session running when declined', async ({ page, home }) => {
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await answerDialogs(page, false);
    const row = sessionRow(page, LABEL.loginFix);
    await row.hover();
    await rowButton(row, 'Stop session').click();
    await expect.poll(() => dialogsAsked(page)).toEqual(['Stop this session?']);
    await expect(terminalStatus(page)).toHaveText('Running');
  });

  test('stops the session and clears the screen when it was on it', async ({ page, home }) => {
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await answerDialogs(page, true);
    const row = sessionRow(page, LABEL.loginFix);
    await row.hover();
    await rowButton(row, 'Stop session').click();
    await expect(page.getByTestId('empty-screen')).toBeVisible();
    await expect(terminalHeader(page)).toBeHidden();
    await expect(sessionItem(page, S.loginFix)).not.toHaveClass(/\bhas-running-pty\b/);
  });

  test('says "disconnect" for a remote session', async ({ page, home }) => {
    await openRemoteSession(page, home, LABEL.remoteApi, S.remoteApi);
    await answerDialogs(page, false);
    const row = sessionRow(page, LABEL.remoteApi);
    await row.hover();
    await rowButton(row, 'Disconnect (keeps running on the remote)').click();
    await expect.poll(() => dialogsAsked(page)).toEqual(['Disconnect? The session keeps running on the remote machine.']);
  });
});

test.describe('archive', () => {
  test('stops the session first, then hides the row', async ({ page, home }) => {
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    const row = sessionRow(page, LABEL.loginFix);
    await row.hover();
    await rowButton(row, 'Archive').click();
    await expect(sessionItem(page, S.loginFix)).toHaveCount(0);
    await expect(page.getByTestId('empty-screen')).toBeVisible();
    expect(await storedSession(page, S.loginFix)).toMatchObject({ archived: 1 });
    expect(await page.evaluate(() => window.api.getActiveSessions())).not.toContain(S.loginFix);
  });

  test('keeps the row, and says so, when the session cannot be stopped', async ({ page, app }) => {
    await failStopSession(app, 'the PTY would not die');
    await answerDialogs(page, true);
    const row = sessionRow(page, LABEL.chartsDarkMode);
    await row.hover();
    await rowButton(row, 'Archive').click();
    await expect.poll(() => dialogsAsked(page)).toEqual(['Could not stop this session: the PTY would not die']);
    await expect(row).toBeVisible();
    expect(await rowNode(page, S.chartsDarkMode)).toMatchObject({ leaving: false });
    expect(await storedSession(page, S.chartsDarkMode)).toMatchObject({ archived: 0 });
  });

  test('brings the row back when archiving fails', async ({ page, app }) => {
    await failInvoke(app, 'archiveSession', 'the database is locked');
    const row = sessionRow(page, LABEL.chartsDarkMode);
    await row.hover();
    await rowButton(row, 'Archive').click();
    await expect.poll(async () => (await rowNode(page, S.chartsDarkMode))?.leaving).toBe(false);
    await expect(row).toBeVisible();
  });

  test('forgets a pending row entirely', async ({ page, home }) => {
    const before = launchedKeys(home);
    await page.getByRole('button', { name: 'New session', exact: true }).click();
    await dialog(page, 'New Session').getByText(P.webDashboard, { exact: true }).click();
    const claude = await waitForNewLaunch(home, 'claude', before);
    const row = sessionItem(page, claude.key);
    await expect(row).toHaveCount(1);
    await row.hover();
    await row.getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(row).toHaveCount(0);
    await sidebarFilter(page, 'archived').click();
    await expect(sessionItem(page, claude.key)).toHaveCount(0);
  });

  test.describe('on a paused clock', () => {
    test.use({ fakeTimers: true });

    test('with reduced motion, pauses 450ms before acting', async ({ page }) => {
      await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000);
      const row = sessionRow(page, LABEL.chartsDarkMode);
      await row.hover();
      await rowButton(row, 'Archive').click();
      await page.clock.runFor(440);
      await page.waitForTimeout(300);
      expect(await storedSession(page, S.chartsDarkMode)).toMatchObject({ archived: 0 });
      await page.clock.runFor(20);
      await expect.poll(() => storedSession(page, S.chartsDarkMode)).toMatchObject({ archived: 1 });
      await page.clock.resume();
      await expect(sessionItem(page, S.chartsDarkMode)).toHaveCount(0);
    });

    test('slides aside and dims at 260ms, then closes the gap at 600ms', async ({ page }) => {
      await allowMotion(page);
      await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000);
      const row = sessionRow(page, LABEL.chartsDarkMode);
      await row.hover();
      await rowButton(row, 'Archive').click();

      await page.clock.runFor(250);
      expect(await rowNode(page, S.chartsDarkMode)).toMatchObject({ transform: '', height: '' });
      await page.clock.runFor(300);
      const sliding = (await rowNode(page, S.chartsDarkMode))!;
      expect(sliding.transform).toMatch(/^translate3d\(2\d(\.\d+)?px, 0px/);
      expect(Number(sliding.opacity)).toBeLessThan(0.6);
      expect(sliding.height).toBe('');
      await page.clock.runFor(100);
      expect((await rowNode(page, S.chartsDarkMode))!.height).toMatch(/px$/);

      await page.clock.runFor(3000);
      await page.clock.resume();
      await expect(sessionItem(page, S.chartsDarkMode)).toHaveCount(0);
    });
  });

  test('throws confetti, and more of it every fifth time', async ({ page }) => {
    await allowMotion(page);
    await startMotionRecorder(page);
    for (const [id, label] of [
      [S.loginFix, LABEL.loginFix], [S.worktreeTry, LABEL.worktreeTry], [S.chartsDarkMode, LABEL.chartsDarkMode],
      [S.parserExperiment, LABEL.parserExperiment], [S.releaseNotes, LABEL.releaseNotes],
    ] as const) {
      const row = sessionRow(page, label);
      await row.hover();
      await rowButton(row, 'Archive').click();
      await expect(sessionItem(page, id)).toHaveCount(0);
    }
    expect((await readMotion(page)).confetti).toEqual([28, 28, 28, 28, 70]);
  });
});

test.describe('group archive', () => {
  test('archives every session in the group', async ({ page }) => {
    const header = sessionRow(page, LABEL.billingGroup).first();
    await header.hover();
    await rowButton(header, 'Archive all sessions in group').click();
    await expect(sidebar(page).getByText('3 sessions', { exact: true })).toHaveCount(0);
    for (const id of [S.billingPlan, S.billingStep1, S.billingStep2]) {
      expect(await storedSession(page, id)).toMatchObject({ archived: 1 });
    }
    await sidebarFilter(page, 'archived').click();
    await expect(sidebar(page).getByText('3 sessions', { exact: true })).toBeVisible();
  });

  test('stops at the first session it cannot stop, and the group comes back', async ({ page, app }) => {
    await failStopSession(app, 'the PTY would not die');
    await answerDialogs(page, true);
    const header = sessionRow(page, LABEL.billingGroup).first();
    await header.hover();
    await rowButton(header, 'Archive all sessions in group').click();
    await expect.poll(() => dialogsAsked(page)).toEqual(['Could not stop this session: the PTY would not die']);
    await expect(header).toBeVisible();
    await page.waitForTimeout(500);
    expect(await dialogsAsked(page)).toHaveLength(1);
    for (const id of [S.billingPlan, S.billingStep1, S.billingStep2]) {
      expect(await storedSession(page, id)).toMatchObject({ archived: 0 });
    }
  });
});

test.describe('clicks elsewhere on a row', () => {
  test('the group header folds the group', async ({ page }) => {
    const header = sessionRow(page, LABEL.billingGroup).first();
    await header.click();
    await expect(sessionRow(page, BILLING_STEP_1)).toBeVisible();
    await header.click();
    await expect(sessionRow(page, BILLING_STEP_1)).toBeHidden();
  });

  test('"+ N older" shows and hides the older rows', async ({ page }) => {
    await sidebar(page).getByText('+ 3 older', { exact: true }).click();
    await expect(sessionRow(page, LABEL.meetingNotes)).toBeVisible();
    await sidebar(page).getByText('- hide older', { exact: true }).click();
    await expect(sessionRow(page, LABEL.meetingNotes)).toBeHidden();
    await expect(sidebar(page).getByText('+ 3 older', { exact: true })).toBeVisible();
  });

  test('a row\'s project label no longer opens the repository', async ({ page, app, home }) => {
    // Display only now (the meta line is the Session work button where it can
    // open); outside a git repository the click is the row's.
    await sessionItem(page, S.chartsDarkMode).getByText(P.webDashboard, { exact: true }).click();
    await fakeClaude(home, S.chartsDarkMode).launched();
    expect((await openedExternally(app)).filter(url => url.startsWith('repository:'))).toEqual([]);
  });

  test('a remote project label is not a repository link', async ({ page, app, home }) => {
    await sessionItem(page, S.remoteApi).getByText(/^joris@buildbox\.local/).click();
    // The click falls through to the row, which dials the remote.
    await openRemoteSession(page, home, LABEL.remoteApi, S.remoteApi);
    expect((await openedExternally(app)).filter(url => url.startsWith('repository:'))).toEqual([]);
  });
});

// ── Rename ──

test.describe('rename', () => {
  test('a double-click opens the input with the name selected', async ({ page, home }) => {
    await startMouseRename(page, home, LABEL.loginFix, S.loginFix);
    const input = renameInput(page);
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(LABEL.loginFix);
    expect(await input.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]))
      .toEqual([0, LABEL.loginFix.length]);
  });

  test('R and F2 on the keyboard cursor open it too', async ({ page }) => {
    await page.keyboard.press('Meta+l');
    await page.keyboard.press('ArrowDown');
    // Escape hands the keyboard back to the list, cursor on the same row.
    for (const key of ['r', 'F2']) {
      await page.keyboard.press(key);
      const input = renameInput(page);
      await expect(input).toBeFocused();
      await expect(input).toHaveValue(LABEL.loginFix);
      await page.keyboard.press('Escape');
      await expect(input).toHaveCount(0);
      await expect(listScroller(page)).toBeFocused();
    }
  });

  test('Enter saves', async ({ page, home }) => {
    await startMouseRename(page, home, LABEL.loginFix, S.loginFix);
    await renameInput(page).fill('Redirect loop, take two');
    await page.keyboard.press('Enter');
    await expect(sessionRow(page, 'Redirect loop, take two')).toBeVisible();
    expect(await storedSession(page, S.loginFix)).toMatchObject({ name: 'Redirect loop, take two' });
  });

  test('leaving the input saves', async ({ page, home }) => {
    await startMouseRename(page, home, LABEL.loginFix, S.loginFix);
    await renameInput(page).fill('Saved on blur');
    await renameInput(page).blur();
    await expect(sessionRow(page, 'Saved on blur')).toBeVisible();
    await expect.poll(() => storedSession(page, S.loginFix)).toMatchObject({ name: 'Saved on blur' });
  });

  test('Escape cancels without saving', async ({ page, home }) => {
    await startMouseRename(page, home, LABEL.loginFix, S.loginFix);
    await renameInput(page).fill('Never saved');
    await page.keyboard.press('Escape');
    await expect(sessionRow(page, LABEL.loginFix)).toBeVisible();
    await expect(renameInput(page)).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(await storedSession(page, S.loginFix)).toMatchObject({ name: null });
  });

  test('an empty name clears the rename, so the row follows the CLI title again', async ({ page, home }) => {
    await startMouseRename(page, home, LABEL.chartsDarkMode, S.chartsDarkMode);
    await renameInput(page).fill('');
    await page.keyboard.press('Enter');
    await expect(sessionRow(page, 'Add a dark mode to the dashboard charts')).toBeVisible();
    expect(await storedSession(page, S.chartsDarkMode)).toMatchObject({ name: null });
  });

  test('typing the fallback title back stores no name', async ({ page, home }) => {
    await startMouseRename(page, home, LABEL.chartsDarkMode, S.chartsDarkMode);
    await renameInput(page).fill('Add a dark mode to the dashboard charts');
    await page.keyboard.press('Enter');
    await expect(sessionRow(page, 'Add a dark mode to the dashboard charts')).toBeVisible();
    await expect.poll(() => storedSession(page, S.chartsDarkMode)).toMatchObject({ name: null });
  });

  test('after a keyboard rename the list keeps the keyboard and the cursor', async ({ page, home }) => {
    await page.keyboard.press('Meta+l');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('r');
    await renameInput(page).fill('Renamed from the keyboard');
    await page.keyboard.press('Enter');
    await expect(sessionRow(page, 'Renamed from the keyboard')).toBeVisible();
    await expect(listScroller(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await fakeClaude(home, S.loginFix).launched();
  });
});

// ── Screenshots ──

forEachAppearance(() => {
  test('session list, every row state', async ({ page, app, home }) => {
    await sessionRow(page, LABEL.billingGroup).first().click();
    const login = await openSession(page, home, LABEL.loginFix, S.loginFix);
    const worktree = await openSession(page, home, LABEL.worktreeTry, S.worktreeTry);
    const charts = await openSession(page, home, LABEL.chartsDarkMode, S.chartsDarkMode);
    await openSession(page, home, BILLING_STEP_1, S.billingStep1);
    await worktree.status({ state: 'working' });
    await worktree.status({ state: 'working', id: 'agents/1', title: 'Explore the cookie store' });
    await charts.status({ state: 'working' });
    await charts.status({ state: 'idle' });
    await login.status({ state: 'working' });
    await askQuestions(home, S.loginFix, [{ question: 'Scope?', options: [{ label: 'Site' }, { label: 'App' }] }]);
    await redraw(page, app, S.bumpDeps);
    await expect(sidebar(page).getByText('Asking 1 question', { exact: true })).toBeVisible();
    await expect(sessionItem(page, S.worktreeTry).getByTitle(/^1 agent working/)).toBeVisible();
    await expect(sessionItem(page, S.chartsDarkMode)).toHaveClass(/\bresponse-ready\b/);
    await expectScreen(page, 'session-list-row-states');
  });
});
