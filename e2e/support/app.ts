/**
 * Small, UI-level steps most specs share: waiting for the first index,
 * opening a session, taking a screenshot.
 *
 * Elements are found by role, label or visible text, never by the vanilla
 * renderer's ids and classes, so these keep working while the renderer is
 * rewritten. Where the current markup offers no accessible handle the helper
 * says so; the fix is a `data-testid` in the markup, not a CSS selector here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { EVENT } from '../../src/ipc/channels';
import { fakeClaude, fakeSsh } from './fake-cli';
import { pushEvent } from './main-process';
import type { FakeCli } from './fake-cli';
import type { FixtureHome, FixtureSpec } from './fixture-home';

/**
 * Wait until the app has indexed every fixture session and drawn the list.
 *
 * A fresh data dir means a cold start: the renderer first paints from an empty
 * cache, a worker scans the transcripts, and the list redraws when it is done.
 *
 * The scan ends by writing "Indexed N sessions across M projects" into the
 * sidebar footer, where it lingers for a few seconds — long enough to be in
 * some screenshots and not others, and it may land before or after the
 * launcher's reload. So the wait is on the app's own log line for it, after
 * which the footer is cleared the way main itself clears it (an empty status,
 * sent after the one it replaces). Every test then starts with the scan
 * finished and the footer quiet.
 */
export async function waitForIndex(page: Page, app: ElectronApplication, home: FixtureHome): Promise<void> {
  await expect.poll(() => /\[status\] \(done\) Indexed /.test(appLog(home)), {
    message: 'the cold-start index to finish', timeout: 20_000,
  }).toBe(true);
  await pushEvent(app, EVENT.statusUpdate, '', '');
  await expect(sidebar(page).getByText(/^Indexed \d+ sessions? across/)).toHaveCount(0);

  const expected = countSessions(home.spec);
  await expect.poll(async () => page.evaluate(async () => {
    const projects = await window.api.getProjects(true);
    return projects.reduce((sum, project) => sum + project.sessions.length, 0);
  }), { message: 'the app to list every fixture session' }).toBe(expected);

  const newest = newestVisibleLabel(home.spec);
  if (newest) await expect(sessionRow(page, newest).first()).toBeVisible();
}

/**
 * The main process's log so far, for waiting on something it reports and for
 * debugging a failure.
 *
 * electron-log writes it under the fixture home (it follows HOME), in a folder
 * named after the app — "Electron" for an unpackaged run.
 */
export function appLog(home: FixtureHome): string {
  const logs = path.join(home.home, 'Library', 'Logs');
  try {
    return fs.readdirSync(logs)
      .map(dir => path.join(logs, dir, 'main.log'))
      .filter(file => fs.existsSync(file))
      .map(file => fs.readFileSync(file, 'utf8'))
      .join('\n');
  } catch {
    return '';
  }
}

function countSessions(spec: FixtureSpec): number {
  const local = (spec.projects ?? []).reduce((sum, p) => sum + p.sessions.length, 0);
  const remote = (spec.remotes ?? []).reduce((sum, r) => sum + (r.sessions?.length ?? 0), 0);
  return local + remote;
}

/** The label of the newest unarchived local session — always in view at the top. */
function newestVisibleLabel(spec: FixtureSpec): string | null {
  const sessions = (spec.projects ?? []).flatMap(p => p.sessions).filter(s => !s.archived && !s.slug);
  sessions.sort((a, b) => b.at - a.at);
  const newest = sessions[0];
  return newest ? newest.name ?? newest.aiTitle ?? newest.prompt : null;
}

// ── Sidebar ──

/** A sidebar filter toggle, by its tooltip. */
export function sidebarFilter(page: Page, filter: 'running' | 'pinned'): Locator {
  const names = {
    running: 'Show running only',
    pinned: 'Show pinned only',
  } as const;
  return page.getByRole('button', { name: names[filter], exact: true });
}

export function searchBox(page: Page): Locator {
  return page.getByPlaceholder('Search sessions...');
}

/**
 * The sidebar. A plain div with no role in the vanilla markup, hence the test
 * id (index.html); anything inside is then found by role or text.
 */
export function sidebar(page: Page): Locator {
  return page.getByTestId('sidebar');
}

/**
 * The strip under the session list: the running count, the activity line, the
 * quota gauges and the update notice. A plain div, hence the test id.
 */
export function sidebarFooter(page: Page): Locator {
  return page.getByTestId('sidebar-footer');
}

/** The bar above the terminal: name, process title, id, status, stop. */
export function terminalHeader(page: Page): Locator {
  return page.getByTestId('terminal-header');
}

/** A session row's label in the sidebar. Click it to open the session. */
export function sessionRow(page: Page, label: string): Locator {
  return sidebar(page).getByText(label, { exact: true });
}

/**
 * A row's action buttons, found through the row's label.
 *
 * Rows have no role in the vanilla markup, so this climbs from the label to
 * the nearest ancestor that holds buttons — the row itself — without naming
 * a class. Works for session rows, slug groups and project picker rows alike.
 */
export function rowButton(row: Locator, name: string): Locator {
  return row.locator('xpath=ancestor::*[.//button][1]').getByRole('button', { name, exact: true });
}

/**
 * Pick an entry from a project's ⋯ menu in the open Projects modal (#171).
 *
 * Only the highlighted row shows its ⋯, so the pointer goes over the row
 * first, which highlights it.
 */
export async function chooseProjectAction(page: Page, label: string | RegExp, item: string | RegExp): Promise<void> {
  const modal = dialog(page, 'Projects');
  await modal.getByText(label, { exact: true }).hover();
  await modal.getByRole('button', { name: /^More for / }).click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

/**
 * A modal dialog, by its title.
 *
 * The vanilla dialogs are plain divs with an `<h3>` title, so this is the
 * heading's parent. A port that gives them `role="dialog"` and a label should
 * switch this to `page.getByRole('dialog', { name: title })`; the specs only
 * ever go through here.
 */
export function dialog(page: Page, title: string | RegExp): Locator {
  return page.getByRole('heading', { name: title }).locator('..');
}

/**
 * Open a local session by its row label and wait for the fake `claude` to
 * start under it and the header to say so. Clicking a session that is not
 * running resumes it.
 *
 * The terminal itself is drawn on a canvas (xterm's WebGL renderer), so its
 * text is not in the DOM: assert on what the fake recorded (`input()`), on the
 * header, or with a screenshot.
 */
export async function openSession(page: Page, home: FixtureHome, label: string, sessionId: string): Promise<FakeCli> {
  await sessionRow(page, label).first().click();
  const claude = fakeClaude(home, sessionId);
  await claude.launched();
  await expect(terminalStatus(page)).toHaveText('Running');
  return claude;
}

/**
 * The terminal header's running/stopped label.
 *
 * No accessible handle in the vanilla markup (a bare span), so this matches
 * the label's possible texts; a port that gives it a role or a test id should
 * switch this over.
 */
export function terminalStatus(page: Page): Locator {
  return terminalHeader(page).getByText(/^(Running|Stopped|Connecting…|Reconnecting…|Reconnecting in \d+s)$/);
}

/** Open a remote session by its row label and wait for the fake `ssh` to dial. */
export async function openRemoteSession(page: Page, home: FixtureHome, label: string, sessionId: string): Promise<FakeCli> {
  await sessionRow(page, label).click();
  const ssh = fakeSsh(home, sessionId);
  await ssh.launched();
  return ssh;
}

// ── Screenshots ──

/**
 * Set SB_E2E_SKIP_SCREENSHOTS=1 to run every functional assertion but skip
 * the pixel comparisons — for a machine whose fonts or GPU render differently
 * from the one the baselines were made on (CI does this; see CONTRIBUTING.md).
 */
export const SCREENSHOTS_SKIPPED = !!process.env.SB_E2E_SKIP_SCREENSHOTS;

/**
 * Regions that change between otherwise identical runs, painted over in every
 * screenshot.
 *
 * Kept short on purpose: the clock is frozen and the ids are stable, so what
 * is left is the app's own version number (in global settings), which moves
 * with every release.
 */
export function volatileRegions(page: Page): Locator[] {
  return [page.getByText(/^v\d+\.\d+\.\d+/)];
}

/**
 * Compare the whole window against `<name>-<scheme>-<platform>.png`.
 *
 * Whole-window rather than per-element, so the comparison does not depend on
 * how the markup is divided up — the thing a renderer port changes. The
 * scheme (`light`/`dark`) is read off the page rather than passed in, so a
 * baseline can never be filed under the wrong one. The pointer is parked in a
 * corner first so no hover state or tooltip leaks in.
 *
 * `soft` records a mismatch and carries on, for a test that walks several
 * screens in one launch: every screen is still compared, not just the ones
 * before the first that differs.
 */
export async function expectScreen(
  page: Page, name: string, { mask = [] as Locator[], soft = false } = {},
): Promise<void> {
  const scheme = await page.evaluate(() =>
    matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const file = `${name}-${scheme}.png`;
  if (SCREENSHOTS_SKIPPED) {
    test.info().annotations.push({ type: 'screenshot skipped', description: file });
    return;
  }
  await page.mouse.move(1279, 799);
  await (soft ? expect.soft(page) : expect(page)).toHaveScreenshot(file, {
    mask: [...volatileRegions(page), ...mask],
  });
}
