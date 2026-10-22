/**
 * The session list, wired to the real app: statuses from the CLI filing rows
 * under their sections, what a redraw leaves alone, where the keyboard goes,
 * the row actions that go through main (pin, stop, archive, rename), the
 * blank space under the list, and the motion.
 *
 * The rules behind it — the order, the sections, the anchoring, the
 * truncation, the labels, which buttons a row offers, what a rename stores —
 * are unit tested against the pure layout and the session-list slice
 * (`test/session-list-layout.test.ts`, `test/session-list-slice.test.ts`,
 * `test/session-list-row-labels.test.ts`, `test/session-list-redraw.test.ts`).
 * The screenshots of the plain list, its filters and the older sessions are
 * in `sidebar.spec.ts`; the ones here add the row states and an open slug
 * group.
 */
import { test, expect, forEachAppearance } from '../support/test';
import {
  dialog, expectScreen, openRemoteSession, openSession, rowButton, searchBox, sessionRow, sidebar,
  terminalHeader, terminalStatus,
} from '../support/app';
import { fakeClaude, launchedKeys, waitForNewLaunch } from '../support/fake-cli';
import { minutesAgo, sessionId } from '../support/fixture-home';
import { failStopSession, windowPosition } from '../support/main-process';
import { answerDialogs, dialogsAsked } from '../support/native-dialogs';
import { askQuestions } from '../support/questions';
import {
  allowMotion, expectInOrder, expectRowsInOrder, failInvoke, listScroller,
  readMotion, redraw, renameInput, rowNode, sectionOf, sessionItem, startMotionRecorder, storedSession, tagRow,
} from '../support/session-list';
import { LABEL, P, S } from '../fixtures/standard';
import type { Page } from '@playwright/test';
import type { FixtureSpec } from '../support/fixture-home';

const BILLING_PLAN = 'Plan how to move billing out of the monolith';
const BILLING_STEP_1 = 'Implement the plan: extract the invoice model';

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
  test('needs input, ready, working, pinned, then recent; a busy↔idle flip moves the open row', async ({ page, app, home }) => {
    /* Given */
    const login = await openSession(page, home, LABEL.loginFix, S.loginFix);
    const charts = await openSession(page, home, LABEL.chartsDarkMode, S.chartsDarkMode);
    const worktree = await openSession(page, home, LABEL.worktreeTry, S.worktreeTry);

    /* When */
    await charts.status({ state: 'working' });
    await login.status({ state: 'blocked', kind: 'permission' });
    await redraw(page, app, S.bumpDeps);

    /* Then */
    expect(await sectionOf(page, LABEL.loginFix)).toBe('Needs input');
    expect(await sectionOf(page, LABEL.worktreeTry)).toBe('Ready');
    expect(await sectionOf(page, LABEL.chartsDarkMode)).toBe('Working');
    expect(await sectionOf(page, LABEL.releaseNotes)).toBe('Pinned');
    expect(await sectionOf(page, LABEL.billingGroup)).toBe('Recent');
    await expectInOrder(page, [
      'Needs input', LABEL.loginFix, 'Ready', LABEL.worktreeTry, 'Working', LABEL.chartsDarkMode,
      'Pinned', LABEL.releaseNotes, 'Recent', LABEL.billingGroup, LABEL.remoteApi, LABEL.parserExperiment,
    ]);

    /* When */
    await worktree.status({ state: 'working' });

    /* Then */
    await expect.poll(() => sectionOf(page, LABEL.worktreeTry)).toBe('Working');

    /* When */
    await worktree.status({ state: 'idle' });

    /* Then */
    await expect.poll(() => sectionOf(page, LABEL.worktreeTry)).toBe('Ready');
  });
});

// ── Truncation ──

test.describe('truncation', () => {
  test('rows older than the age limit fold behind "+ N older", which opens, survives a redraw and closes', async ({ page, app }) => {
    /* When */
    await sidebar(page).getByText('+ 3 older', { exact: true }).click();

    /* Then */
    await expect(sessionRow(page, LABEL.meetingNotes)).toBeVisible();
    await expect(sidebar(page).getByText('- hide older', { exact: true })).toBeVisible();

    /* When */
    await redraw(page, app, S.flakyE2e);

    /* Then */
    await expect(sidebar(page).getByText('- hide older', { exact: true })).toBeVisible();
    await expect(sessionRow(page, LABEL.meetingNotes)).toBeVisible();

    /* When */
    await sidebar(page).getByText('- hide older', { exact: true }).click();

    /* Then */
    await expect(sidebar(page).getByText('+ 3 older', { exact: true })).toBeVisible();
    await expect(sessionRow(page, LABEL.meetingNotes)).toBeHidden();
    await expect(sessionRow(page, LABEL.bumpDeps)).toBeHidden();
    // Pinned five days ago, and a remote last opened three hours ago: both stay.
    await expect(sessionRow(page, LABEL.releaseNotes)).toBeVisible();
    await expect(sessionRow(page, LABEL.remoteApi)).toBeVisible();
  });
});

// ── What a redraw leaves alone ──

test.describe('a redraw keeps', () => {
  test.describe('on a long list', () => {
    test.use({ fixture: manySessions(40) });

    test('the scroll position', async ({ page, app }) => {
      /* Given */
      await listScroller(page).evaluate(el => { el.scrollTop = 300; });

      /* When */
      await redraw(page, app, sessionId('many-39'));

      /* Then */
      expect(await listScroller(page).evaluate(el => el.scrollTop)).toBe(300);
    });
  });
});

// ── Focus ──

test.describe('after a redraw', () => {
  test('the terminal takes the keyboard back, but not from the search box, the list or the question panel', async ({ page, app, home }) => {
    /* Given */
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    /* When */
    await redraw(page, app, S.bumpDeps);

    /* Then */
    await expect(terminalInput(page)).toBeFocused();

    /* When */
    await searchBox(page).focus();
    await redraw(page, app, S.bumpDeps);

    /* Then */
    await expect(searchBox(page)).toBeFocused();

    /* When */
    await page.keyboard.press('Meta+l');
    await redraw(page, app, S.bumpDeps);

    /* Then */
    await expect(terminalInput(page)).not.toBeFocused();
    await expect(sidebar(page).locator(':focus')).toHaveCount(1);

    /* When */
    await askQuestions(home, S.loginFix, [{ question: 'Which way?', options: [{ label: 'Left' }, { label: 'Right' }] }]);
    const panel = page.getByRole('region', { name: 'Questions from Claude' });
    await panel.getByRole('heading', { name: 'Which way?' }).waitFor();
    await panel.getByRole('button', { name: /Left/ }).focus();
    await redraw(page, app, S.bumpDeps);

    /* Then */
    await expect(terminalInput(page)).not.toBeFocused();
    await expect(panel.getByRole('button', { name: /Left/ })).toBeFocused();
  });
});

// ── What a row shows ──

test.describe('row state', () => {
  test('follows its session: running, busy, on screen, answered unread and needing attention', async ({ page, home }) => {
    /* Given */
    const row = sessionItem(page, S.loginFix);

    /* When */
    const login = await openSession(page, home, LABEL.loginFix, S.loginFix);

    /* Then */
    await expect(row).toHaveClass(/\bhas-running-pty\b/);
    await expect(row).toHaveClass(/\bactive\b/);
    await expect(row.getByTestId('session-status-dot')).toHaveClass(/\brunning\b/);

    /* When */
    await login.status({ state: 'working' });

    /* Then */
    await expect(row).toHaveClass(/\bcli-busy\b/);

    /* When */
    // Look at another session, so the answer arrives unread.
    await sessionRow(page, LABEL.chartsDarkMode).click();
    await login.status({ state: 'idle' });

    /* Then */
    await expect(sessionItem(page, S.chartsDarkMode)).toHaveClass(/\bactive\b/);
    await expect(row).not.toHaveClass(/\bactive\b/);
    await expect(row).toHaveClass(/\bresponse-ready\b/);
    await expect(row).not.toHaveClass(/\bcli-busy\b/);

    /* When */
    await login.notify('Claude needs your permission to use Bash');

    /* Then */
    await expect(row).toHaveClass(/\bneeds-attention\b/);
  });

  test('a plain terminal main started gets a row with the terminal badge and only a stop button', async ({ page, app, home }) => {
    /* When */
    const terminal = await startPlainTerminal(page, home.projectPath(P.notes));
    await redraw(page, app, S.bumpDeps);
    const item = sessionItem(page, terminal);
    await item.hover();

    /* Then */
    await expect(item).toHaveClass(/\bis-terminal\b/);
    await expect(item.getByTestId('terminal-badge')).toHaveCount(1);
    await expect(item.getByRole('button', { includeHidden: true })).toHaveCount(1);
    await expect(item.getByRole('button', { name: 'Stop session', exact: true })).toBeVisible();
  });
});

// ── Slug groups ──

test.describe('slug group', () => {
  test('folds on its header, stays open across a reload, and keeps the session on screen in view', async ({ page, app, home }) => {
    /* When */
    await sessionRow(page, LABEL.billingGroup).first().click();

    /* Then */
    await expect(sessionRow(page, BILLING_STEP_1)).toBeVisible();

    /* When */
    await page.reload();

    /* Then */
    await expect(sessionRow(page, BILLING_STEP_1)).toBeVisible();

    /* When */
    await openSession(page, home, BILLING_PLAN, S.billingPlan);
    await redraw(page, app, S.bumpDeps);

    /* Then */
    // The running session first, the rest behind "+ 2 more".
    await expectRowsInOrder(page, [S.billingPlan, S.billingStep2, S.billingStep1]);
    await expect(sidebar(page).getByText('+ 2 more', { exact: true })).toHaveCount(1);

    /* When */
    await sidebar(page).getByText('3 sessions', { exact: true }).click();

    /* Then */
    await expect(sessionRow(page, BILLING_STEP_1)).toBeHidden();

    /* When */
    await redraw(page, app, S.bumpDeps);

    /* Then */
    // It holds the session on screen, so a redraw opens it again.
    await expect(sessionRow(page, BILLING_STEP_1)).toBeVisible();

    /* When */
    await sidebar(page).getByText('3 sessions', { exact: true }).click();
    await sessionRow(page, BILLING_STEP_1).waitFor({ state: 'hidden' });
    await sidebar(page).getByText('+ 2 more', { exact: true }).dispatchEvent('click');

    /* Then */
    await expect(sessionRow(page, BILLING_STEP_1)).toBeVisible();
  });
});

// ── The space under the list ──

test.describe('under a short list', () => {
  test.use({ fixture: shortList() });

  test('the empty space moves the window on a drag, and puts the session away on a click', async ({ page, app, home }) => {
    /* Given */
    await openSession(page, home, 'A short list, first', sessionId('short-1'));
    const space = page.getByTestId('sidebar-drag-space');
    const before = await windowPosition(app);

    /* When */
    // Dispatched by hand rather than with page.mouse: a real cursor's screenX
    // stays put as the window moves under it, a synthesized one's does not.
    await space.evaluate((space) => {
      const at = (type: string, screenX: number, screenY: number) =>
        space.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 7, screenX, screenY }));
      at('pointerdown', 500, 500);
      at('pointermove', 502, 501);
      at('pointermove', 520, 510);
      at('pointermove', 540, 530);
      at('pointerup', 540, 530);
    });
    await space.dispatchEvent('click');

    /* Then */
    await expect.poll(() => windowPosition(app)).toEqual([before[0]! + 40, before[1]! + 30]);
    // A drag ends in no click, so the session stays on screen.
    await expect(terminalHeader(page)).toBeVisible();
    const box = (await space.boundingBox())!;
    const footer = (await page.getByTestId('sidebar-footer').boundingBox())!;
    expect(box.height).toBeGreaterThan(100);
    // It runs down to the footer, less the list's bottom padding.
    expect(Math.abs(box.y + box.height - footer.y)).toBeLessThanOrEqual(12);
    // Not a CSS drag region: macOS would swallow the click that puts the session away.
    expect(await space.evaluate(el => getComputedStyle(el).getPropertyValue('-webkit-app-region'))).not.toBe('drag');

    /* When */
    await sessionRow(page, 'A short list, second').hover();
    await sessionItem(page, sessionId('short-2')).getByTestId('session-pin').click();

    /* Then */
    await expect(terminalHeader(page)).toBeVisible();

    /* When */
    // A press that barely moves is still a click.
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 2, y + 1);
    await page.mouse.up();

    /* Then */
    await expect(page.getByTestId('empty-screen')).toBeVisible();
    await expect(terminalHeader(page)).toBeHidden();
    await expect(sessionItem(page, sessionId('short-1'))).not.toHaveClass(/\bactive\b/);
  });
});

// ── Row actions ──

test.describe('pin', () => {
  test('pinning moves the row into Pinned once main has stored it; unpinning sends an old row behind "+ N older"', async ({ page }) => {
    /* When */
    await sessionRow(page, LABEL.chartsDarkMode).hover();
    await sessionItem(page, S.chartsDarkMode).getByTestId('session-pin').click();

    /* Then */
    await expect.poll(() => sectionOf(page, LABEL.chartsDarkMode)).toBe('Pinned');
    expect(await storedSession(page, S.chartsDarkMode)).toMatchObject({ starred: 1 });
    await expect(sessionItem(page, S.chartsDarkMode).getByTestId('session-pin')).toHaveClass(/\bpinned\b/);

    /* When */
    await sessionRow(page, LABEL.releaseNotes).hover();
    await sessionItem(page, S.releaseNotes).getByTestId('session-pin').click();

    /* Then */
    await expect(sidebar(page).getByText('+ 4 older', { exact: true })).toBeVisible();
    await expect(sessionRow(page, LABEL.releaseNotes)).toBeHidden();
    expect(await storedSession(page, S.releaseNotes)).toMatchObject({ starred: 0 });
  });
});

test.describe('stop', () => {
  test('asks first, says "disconnect" for a remote, and stops and clears the screen once confirmed', async ({ page, home }) => {
    /* Given */
    await openRemoteSession(page, home, LABEL.remoteApi, S.remoteApi);
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    await answerDialogs(page, false);
    const remote = sessionRow(page, LABEL.remoteApi);
    const login = sessionRow(page, LABEL.loginFix);

    /* When */
    await remote.hover();
    await rowButton(remote, 'Disconnect (keeps running on the remote)').click();

    /* Then */
    await expect.poll(() => dialogsAsked(page)).toEqual(['Disconnect? The session keeps running on the remote machine.']);

    /* When */
    await login.hover();
    await rowButton(login, 'Stop session').click();

    /* Then */
    await expect.poll(async () => (await dialogsAsked(page)).slice(1)).toEqual(['Stop this session?']);
    await expect(terminalStatus(page)).toHaveText('Running');

    /* When */
    await answerDialogs(page, true);
    await login.hover();
    await rowButton(login, 'Stop session').click();

    /* Then */
    await expect(page.getByTestId('empty-screen')).toBeVisible();
    await expect(terminalHeader(page)).toBeHidden();
    await expect(sessionItem(page, S.loginFix)).not.toHaveClass(/\bhas-running-pty\b/);
  });
});

test.describe('archive', () => {
  test('a row is stopped first, then hidden; a group goes whole; a pending row is forgotten', async ({ page, home }) => {
    /* Given */
    await openSession(page, home, LABEL.loginFix, S.loginFix);

    /* When */
    const row = sessionRow(page, LABEL.loginFix);
    await row.hover();
    await rowButton(row, 'Archive').click();

    /* Then */
    await expect(sessionItem(page, S.loginFix)).toHaveCount(0);
    await expect(page.getByTestId('empty-screen')).toBeVisible();
    expect(await storedSession(page, S.loginFix)).toMatchObject({ archived: 1 });
    expect(await page.evaluate(() => window.api.getActiveSessions())).not.toContain(S.loginFix);

    /* When */
    const header = sessionRow(page, LABEL.billingGroup).first();
    await header.hover();
    await rowButton(header, 'Archive all sessions in group').click();

    /* Then */
    await expect(sidebar(page).getByText('3 sessions', { exact: true })).toHaveCount(0);
    for (const id of [S.billingPlan, S.billingStep1, S.billingStep2]) {
      expect(await storedSession(page, id)).toMatchObject({ archived: 1 });
    }

    /* When */
    const before = launchedKeys(home);
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await dialog(page, 'Projects').getByText(P.webDashboard, { exact: true }).click();
    const claude = await waitForNewLaunch(home, 'claude', before);
    const pending = sessionItem(page, claude.key);
    await pending.hover();
    await pending.getByRole('button', { name: 'Archive', exact: true }).click();

    /* Then */
    await expect(pending).toHaveCount(0);
  });

  test('a session found by search is unarchived in place and stays in the list', async ({ page }) => {
    /* Given */
    await allowMotion(page);
    await searchBox(page).fill('GraphQL');
    const row = sessionRow(page, LABEL.graphqlSpike);
    await row.hover();

    /* When */
    await rowButton(row, 'Unarchive').click();

    /* Then */
    await expect.poll(() => storedSession(page, S.graphqlSpike)).toMatchObject({ archived: 0 });
    await expect(row).toBeVisible();
    await expect(sessionItem(page, S.graphqlSpike)).not.toHaveClass(/\barchived-item\b/);
    expect(await rowNode(page, S.graphqlSpike)).toMatchObject({ leaving: false, height: '' });

    /* When */
    await searchBox(page).fill('');

    /* Then */
    await expect(row).toBeVisible();
    await row.hover();
    await expect(rowButton(row, 'Archive')).toBeVisible();
  });

  test('a row or a group comes back, and says so, when archiving or stopping fails', async ({ page, app }) => {
    /* Given */
    await failInvoke(app, 'archiveSession', 'the database is locked');
    await answerDialogs(page, true);
    const row = sessionRow(page, LABEL.chartsDarkMode);

    /* When */
    await row.hover();
    await rowButton(row, 'Archive').click();

    /* Then */
    await expect.poll(async () => (await rowNode(page, S.chartsDarkMode))?.leaving).toBe(false);
    await expect(row).toBeVisible();

    /* When */
    await failStopSession(app, 'the PTY would not die');
    await row.hover();
    await rowButton(row, 'Archive').click();

    /* Then */
    await expect.poll(() => dialogsAsked(page)).toEqual(['Could not stop this session: the PTY would not die']);
    await expect(row).toBeVisible();
    expect(await rowNode(page, S.chartsDarkMode)).toMatchObject({ leaving: false });
    expect(await storedSession(page, S.chartsDarkMode)).toMatchObject({ archived: 0 });

    /* When */
    const header = sessionRow(page, LABEL.billingGroup).first();
    await header.hover();
    await rowButton(header, 'Archive all sessions in group').click();

    /* Then */
    // It stops at the first session it cannot stop.
    await expect.poll(() => dialogsAsked(page)).toHaveLength(2);
    await expect(header).toBeVisible();
    await page.waitForTimeout(500);
    expect(await dialogsAsked(page)).toHaveLength(2);
    for (const id of [S.billingPlan, S.billingStep1, S.billingStep2]) {
      expect(await storedSession(page, id)).toMatchObject({ archived: 0 });
    }
  });

  test.describe('on a paused clock', () => {
    test.use({ fakeTimers: true });

    test('with reduced motion, pauses 450ms before acting, and the row ignores clicks meanwhile', async ({ page, home }) => {
      /* Given */
      await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000);
      const row = sessionRow(page, LABEL.chartsDarkMode);

      /* When */
      await row.hover();
      await rowButton(row, 'Archive').click();
      await row.click();
      await page.clock.runFor(440);
      await page.waitForTimeout(1000);

      /* Then */
      expect(fakeClaude(home, S.chartsDarkMode).launches()).toHaveLength(0);
      expect(await storedSession(page, S.chartsDarkMode)).toMatchObject({ archived: 0 });

      /* When */
      await page.clock.runFor(20);

      /* Then */
      await expect.poll(() => storedSession(page, S.chartsDarkMode)).toMatchObject({ archived: 1 });

      /* When */
      await page.clock.resume();

      /* Then */
      await expect(sessionItem(page, S.chartsDarkMode)).toHaveCount(0);
    });

    test('slides aside and dims at 260ms, keeps its node through a re-sort, then closes the gap at 600ms', async ({ page }) => {
      /* Given */
      await allowMotion(page);
      await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000);
      await tagRow(page, S.chartsDarkMode, 'leaving');
      const row = sessionRow(page, LABEL.chartsDarkMode);

      /* When */
      await row.hover();
      await rowButton(row, 'Archive').click();
      await page.clock.runFor(250);

      /* Then */
      expect(await rowNode(page, S.chartsDarkMode)).toMatchObject({ transform: '', height: '' });

      /* When */
      await page.clock.runFor(300);

      /* Then */
      const sliding = (await rowNode(page, S.chartsDarkMode))!;
      expect(sliding).toMatchObject({ tag: 'leaving', leaving: true, height: '' });
      expect(sliding.transform).toMatch(/^translate3d\(2\d(\.\d+)?px, 0px/);
      expect(Number(sliding.opacity)).toBeLessThan(0.6);

      /* When */
      // A redraw lands mid-slide: the row keeps its node and its slide.
      await sidebar(page).getByText('+ 3 older', { exact: true }).click();

      /* Then */
      expect(await rowNode(page, S.chartsDarkMode)).toMatchObject({ tag: 'leaving', leaving: true, transform: sliding.transform });

      /* When */
      await page.clock.runFor(100);

      /* Then */
      expect((await rowNode(page, S.chartsDarkMode))!.height).toMatch(/px$/);

      /* When */
      await page.clock.runFor(3000);
      await page.clock.resume();

      /* Then */
      await expect(sessionItem(page, S.chartsDarkMode)).toHaveCount(0);
    });
  });
});

// ── Reflow ──

test.describe('reflow', () => {
  test('top-level entries glide to their new place, rows inside a group ride along, a removed row leaves a ghost', async ({ page }) => {
    /* Given */
    await sessionRow(page, LABEL.billingGroup).first().click();
    await sessionRow(page, BILLING_STEP_1).waitFor();
    await allowMotion(page);
    await startMotionRecorder(page);

    /* When */
    // Pinning the parser row lifts it above everything else that is recent.
    await sessionRow(page, LABEL.parserExperiment).hover();
    await sessionItem(page, S.parserExperiment).getByTestId('session-pin').click();

    /* Then */
    await expect.poll(() => sectionOf(page, LABEL.parserExperiment)).toBe('Pinned');
    await expect.poll(async () => (await readMotion(page)).moved).toEqual(expect.arrayContaining([
      S.parserExperiment, S.loginFix, expect.stringMatching(/^slug-/),
    ]));
    const { moved } = await readMotion(page);
    for (const nested of [S.billingPlan, S.billingStep1, S.billingStep2]) expect(moved).not.toContain(nested);

    /* When */
    await startMotionRecorder(page);
    await searchBox(page).fill('login');

    /* Then */
    await expect(sessionRow(page, LABEL.chartsDarkMode)).toHaveCount(0);
    await expect.poll(async () => (await readMotion(page)).ghosts).toBeGreaterThan(0);
  });
});

// ── Rename ──

test.describe('rename', () => {
  test('a double-click opens the input; a redraw keeps it; Escape cancels, Enter and leaving it save', async ({ page, app, home }) => {
    /* Given */
    await openSession(page, home, LABEL.loginFix, S.loginFix);
    // Settle the row in its section first: a row that moves (here, from Recent
    // to Ready) is taken out and put back, and the input loses its focus.
    // Open first, too, because the double-click's own clicks open the session:
    // on one not open yet, the terminal it launches takes the focus a moment
    // later, and the input saves and closes as it loses it.
    await redraw(page, app, S.bumpDeps);
    const input = renameInput(page);

    /* When */
    await sessionRow(page, LABEL.loginFix).dblclick();

    /* Then */
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(LABEL.loginFix);
    expect(await input.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]))
      .toEqual([0, LABEL.loginFix.length]);

    /* When */
    await input.fill('Half-typed name');
    await redraw(page, app, S.flakyE2e);

    /* Then */
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('Half-typed name');

    /* When */
    await page.keyboard.press('Escape');

    /* Then */
    await expect(sessionRow(page, LABEL.loginFix)).toBeVisible();
    await expect(input).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(await storedSession(page, S.loginFix)).toMatchObject({ name: null });

    /* When */
    await sessionRow(page, LABEL.loginFix).dblclick();
    await input.fill('Redirect loop, take two');
    await page.keyboard.press('Enter');

    /* Then */
    await expect(sessionRow(page, 'Redirect loop, take two')).toBeVisible();
    expect(await storedSession(page, S.loginFix)).toMatchObject({ name: 'Redirect loop, take two' });

    /* When */
    await sessionRow(page, 'Redirect loop, take two').dblclick();
    await input.fill('Saved on blur');
    await input.blur();

    /* Then */
    await expect(sessionRow(page, 'Saved on blur')).toBeVisible();
    await expect.poll(() => storedSession(page, S.loginFix)).toMatchObject({ name: 'Saved on blur' });
  });

  test('R and F2 on the keyboard cursor open it, and the list keeps the keyboard and the cursor after', async ({ page, app, home }) => {
    /* Given */
    await page.keyboard.press('Meta+l');
    await page.keyboard.press('ArrowDown');
    const input = renameInput(page);

    /* When */
    await page.keyboard.press('r');

    /* Then */
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(LABEL.loginFix);

    /* When */
    await page.keyboard.press('Escape');

    /* Then */
    // Escape hands the keyboard back to the list, cursor on the same row.
    await expect(input).toHaveCount(0);
    await expect(listScroller(page)).toBeFocused();

    /* When */
    await page.keyboard.press('F2');
    await input.fill('Renamed from the keyboard');
    await page.keyboard.press('Enter');

    /* Then */
    await expect(sessionRow(page, 'Renamed from the keyboard')).toBeVisible();
    await expect(listScroller(page)).toBeFocused();

    /* When */
    // The cursor survives a redraw too: Enter opens the row it sat on.
    await redraw(page, app, S.bumpDeps);
    await page.keyboard.press('Enter');

    /* Then */
    await fakeClaude(home, S.loginFix).launched();
  });
});

// ── Screenshots ──

forEachAppearance(() => {
  test('session list, every row state', async ({ page, app, home }) => {
    /* Given */
    await sessionRow(page, LABEL.billingGroup).first().click();
    const login = await openSession(page, home, LABEL.loginFix, S.loginFix);
    const worktree = await openSession(page, home, LABEL.worktreeTry, S.worktreeTry);
    const charts = await openSession(page, home, LABEL.chartsDarkMode, S.chartsDarkMode);
    await openSession(page, home, BILLING_STEP_1, S.billingStep1);

    /* When */
    await worktree.status({ state: 'working' });
    await worktree.status({ state: 'working', id: 'agents/1', title: 'Explore the cookie store' });
    await charts.status({ state: 'working' });
    await charts.status({ state: 'idle' });
    await login.status({ state: 'working' });
    await askQuestions(home, S.loginFix, [{ question: 'Scope?', options: [{ label: 'Site' }, { label: 'App' }] }]);
    await redraw(page, app, S.bumpDeps);

    /* Then */
    await expect(sidebar(page).getByText('Asking 1 question', { exact: true })).toBeVisible();
    await expect(sessionItem(page, S.worktreeTry).getByTitle(/^1 agent working/)).toBeVisible();
    await expect(sessionItem(page, S.chartsDarkMode)).toHaveClass(/\bresponse-ready\b/);
    await expectScreen(page, 'session-list-row-states');
  });
});
