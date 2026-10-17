/**
 * The renderer's `confirm`, `alert` and `prompt`, answered without a native
 * dialog.
 *
 * Electron draws these as a real modal alert, and for the suite's hidden
 * windows that alert floats free on the desktop and takes focus, however
 * quickly Playwright dismisses it. So every launch replaces them with stubs
 * (installed before the first script, see launch.ts) that record what was
 * asked and answer from a preset: a confirm is declined, as Playwright does
 * with a dialog nobody handles, until a test says otherwise.
 */
import type { Page } from '@playwright/test';

export interface NativeDialog {
  type: 'confirm' | 'alert' | 'prompt';
  message: string;
}

interface DialogStubs {
  shown: NativeDialog[];
  accept: boolean;
}

type StubbedWindow = Window & { __e2eDialogs: DialogStubs };

/** The init script. Runs in the page, so it closes over nothing. */
export function stubNativeDialogs(): void {
  const stubs: DialogStubs = { shown: [], accept: false };
  (window as unknown as StubbedWindow).__e2eDialogs = stubs;
  window.confirm = (message?: string) => {
    stubs.shown.push({ type: 'confirm', message: String(message ?? '') });
    return stubs.accept;
  };
  window.alert = (message?: unknown) => {
    stubs.shown.push({ type: 'alert', message: String(message ?? '') });
  };
  window.prompt = (message?: string) => {
    stubs.shown.push({ type: 'prompt', message: String(message ?? '') });
    return null;
  };
}

/** Answer every `confirm` from now on with `accept`, and forget what was shown before. */
export async function answerDialogs(page: Page, accept: boolean): Promise<void> {
  await page.evaluate((accept) => {
    const stubs = (window as unknown as StubbedWindow).__e2eDialogs;
    stubs.accept = accept;
    stubs.shown.length = 0;
  }, accept);
}

/** Every `confirm`/`alert`/`prompt` since the last `answerDialogs`, in order. */
export async function dialogsShown(page: Page): Promise<NativeDialog[]> {
  return await page.evaluate(() => [...(window as unknown as StubbedWindow).__e2eDialogs.shown]);
}

/** Just their messages. */
export async function dialogsAsked(page: Page): Promise<string[]> {
  return (await dialogsShown(page)).map(dialog => dialog.message);
}
