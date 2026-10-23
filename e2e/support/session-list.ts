/**
 * Steps for the session list's own spec: finding a row by its session, forcing
 * a redraw, reading the on-screen order, and watching the list's motion.
 *
 * Two of these reach past roles and text, each for a reason:
 *
 * - A row is found by its `data-session-id`. That attribute is a contract in
 *   its own right — the stop's settle motion finds the row by it — and the
 *   state classes a row carries are the thing being checked.
 * - Motion has no accessible handle at all. The recorder watches the inline
 *   transforms and opacities the springs write, and the ghosts a removed row
 *   leaves, which is the only place an animation is observable.
 */
import { expect } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { EVENT, INVOKE } from '../../src/ipc/channels';
import { sidebar } from './app';
import { pushEvent } from './main-process';

/** The row (`.session-item`) of one session, by its id. */
export function sessionItem(page: Page, sessionId: string): Locator {
  return sidebar(page).locator(`[data-session-id="${sessionId}"]`);
}

/** The scrolling container the list lives in. A plain div, hence the test id. */
export function listScroller(page: Page): Locator {
  return page.getByTestId('sidebar-content');
}

/** The rename input, which is the list's only text field (the search box sits above it). */
export function renameInput(page: Page): Locator {
  return listScroller(page).getByRole('textbox');
}

/** Assert the rows of these sessions appear top to bottom in this order. */
export async function expectRowsInOrder(page: Page, sessionIds: readonly string[]): Promise<void> {
  const ys: number[] = [];
  for (const id of sessionIds) {
    const box = await sessionItem(page, id).boundingBox();
    expect(box, `the row of ${id} is on screen`).not.toBeNull();
    ys.push(box!.y);
  }
  expect(ys).toEqual([...ys].sort((a, b) => a - b));
}

/** Redraws per page, so a marker is the same on every run of a test. */
const redraws = new WeakMap<Page, number>();

/**
 * Redraw the list from freshly fetched projects, without a re-sort, and wait
 * until the redraw has landed.
 *
 * What a transcript write does, minus the transcript: `projectsChanged` makes
 * the renderer re-fetch and redraw. To know the redraw has happened, a
 * bystander session is renamed first; its new name showing up (visible or not)
 * is the proof. Pick a bystander the test does not look at.
 */
export async function redraw(page: Page, app: ElectronApplication, bystander: string): Promise<void> {
  const count = (redraws.get(page) ?? 0) + 1;
  redraws.set(page, count);
  const marker = `redraw marker ${count}`;
  await page.evaluate(({ id, name }) => window.api.renameSession(id, name), { id: bystander, name: marker });
  await pushEvent(app, EVENT.projectsChanged);
  await expect(sidebar(page).getByText(marker, { exact: true })).toHaveCount(1);
}

/** Assert the texts appear top to bottom in this order (each must be visible). */
export async function expectInOrder(page: Page, texts: readonly string[]): Promise<void> {
  const ys: number[] = [];
  for (const text of texts) {
    const box = await sidebar(page).getByText(text, { exact: true }).first().boundingBox();
    expect(box, `"${text}" is on screen`).not.toBeNull();
    ys.push(box!.y);
  }
  const sorted = [...ys].sort((a, b) => a - b);
  expect(ys, `${texts.join(' → ')} top to bottom`).toEqual(sorted);
}

/** Whether `text` sits below the section label `section` and above the next label. */
export async function sectionOf(page: Page, text: string): Promise<string | null> {
  const labels = ['Needs input', 'Ready', 'Working', 'Pinned', 'Recent'];
  const rowBox = await sidebar(page).getByText(text, { exact: true }).first().boundingBox();
  if (!rowBox) return null;
  let best: { label: string; y: number } | null = null;
  for (const label of labels) {
    const loc = sidebar(page).getByText(label, { exact: true });
    if (await loc.count() === 0) continue;
    const box = await loc.first().boundingBox();
    if (!box || box.y > rowBox.y) continue;
    if (!best || box.y > best.y) best = { label, y: box.y };
  }
  return best?.label ?? null;
}

/** Let the springs run: the e2e launch asks for reduced motion, which skips every animation. */
export async function allowMotion(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: null });
  await expect.poll(() => page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(false);
}

/** What the recorder saw since `startMotionRecorder`. */
export interface MotionRecord {
  /** Session ids or element ids whose inline transform was set to a translation. */
  moved: string[];
  /** Session ids or element ids whose inline opacity was set below 1. */
  faded: string[];
  /** How many ghosts of removed entries were put up. */
  ghosts: number;
  /** Particles per confetti burst, in order. */
  confetti: number[];
}

/**
 * Start watching the list's motion. Idempotent per page load; call
 * `readMotion` to see what happened, `resetMotion` to start over.
 */
export async function startMotionRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    type Rec = { moved: Set<string>; faded: Set<string>; ghosts: number; confetti: number[] };
    const w = window as unknown as { __motion?: Rec; __motionObserver?: MutationObserver };
    w.__motion = { moved: new Set(), faded: new Set(), ghosts: 0, confetti: [] };
    if (w.__motionObserver) return;
    const name = (el: HTMLElement): string => el.dataset.sessionId ?? el.id;
    const observer = new MutationObserver((mutations) => {
      const rec = w.__motion!;
      for (const m of mutations) {
        if (m.type === 'attributes' && m.target instanceof HTMLElement) {
          const el = m.target;
          if (el.classList.contains('motion-ghost') || !el.closest('#sidebar-content')) continue;
          const shift = /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(el.style.transform);
          if (shift && Math.abs(Number(shift[1])) + Math.abs(Number(shift[2])) > 0.01) rec.moved.add(name(el));
          if (el.style.opacity !== '' && Number(el.style.opacity) < 1) rec.faded.add(name(el));
        }
        if (m.type === 'childList') {
          for (const node of m.addedNodes) {
            if (!(node instanceof HTMLElement)) continue;
            if (node.classList.contains('motion-ghost')) rec.ghosts++;
            if (node.classList.contains('confetti')) rec.confetti.push(node.children.length);
          }
        }
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] });
    w.__motionObserver = observer;
  });
}

export async function readMotion(page: Page): Promise<MotionRecord> {
  return await page.evaluate(() => {
    const rec = (window as unknown as {
      __motion: { moved: Set<string>; faded: Set<string>; ghosts: number; confetti: number[] };
    }).__motion;
    return { moved: [...rec.moved], faded: [...rec.faded], ghosts: rec.ghosts, confetti: [...rec.confetti] };
  });
}

/**
 * Tag the DOM node of a row, so "the same row" later means the same node and
 * not one that merely looks alike after a remove and re-add.
 */
export async function tagRow(page: Page, sessionId: string, tag: string): Promise<void> {
  await page.evaluate(({ id, tag }) => {
    const row = document.querySelector(`[data-session-id="${id}"]`) as (HTMLElement & { e2eTag?: string }) | null;
    if (!row) throw new Error(`no row for ${id}`);
    row.e2eTag = tag;
  }, { id: sessionId, tag });
}

/** The tag on the node now holding the row, and that node's inline motion. */
export async function rowNode(page: Page, sessionId: string): Promise<{
  tag?: string; transform: string; opacity: string; height: string; leaving: boolean;
} | null> {
  return await page.evaluate((id) => {
    const row = document.querySelector(`[data-session-id="${id}"]`) as (HTMLElement & { e2eTag?: string }) | null;
    if (!row) return null;
    return {
      tag: row.e2eTag,
      transform: row.style.transform,
      opacity: row.style.opacity,
      height: row.style.height,
      leaving: row.hasAttribute('data-leaving'),
    };
  }, sessionId);
}

/** Make one IPC handler fail with `message`, as a broken main process would. */
export async function failInvoke(app: ElectronApplication, channel: keyof typeof INVOKE, message: string): Promise<void> {
  await app.evaluate(({ ipcMain }, { channel, message }) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, () => { throw new Error(message); });
  }, { channel: INVOKE[channel], message });
}

/** What main has stored for one session (name, star, archive, snooze), read the way the renderer reads it. */
export async function storedSession(page: Page, sessionId: string): Promise<{
  name: string | null; starred: number; archived: number; snoozedUntil: string | null;
} | null> {
  return await page.evaluate(async (id) => {
    const projects = await window.api.getProjects(true);
    for (const project of projects) {
      const found = project.sessions.find(s => s.sessionId === id);
      if (found) {
        return {
          name: found.name ?? null, starred: found.starred ?? 0, archived: found.archived ?? 0,
          snoozedUntil: found.snoozedUntil ?? null,
        };
      }
    }
    return null;
  }, sessionId);
}

/**
 * Whatever the keyboard cursor is on: a row, a group header or a "more"
 * toggle.
 *
 * The cursor has no accessible handle — it is a highlight, not a selection
 * the platform knows about — so this is the one place that names its class.
 */
export function keyboardCursor(page: Page): Locator {
  return listScroller(page).locator('.kbd-cursor');
}
