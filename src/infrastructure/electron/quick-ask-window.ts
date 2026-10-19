/**
 * The Quick Ask pop-up's window (#142), following the spike (#144).
 *
 * A non-activating panel: it takes the keyboard without bringing Switchboard
 * forward, so the app the user was in stays frontmost the whole time, and
 * closing only hides the panel (B5). `app.hide()` is never called; it would
 * hide the main window as well, as ⌘H does.
 *
 * The window is a still transparent area larger than the slab (G3). Mouse
 * events pass through it except over the slab, which the pop-up reports as
 * the pointer moves, so a click beside the slab reaches the window underneath.
 * The glass moves inside it in CSS (#150), and each show tells the pop-up the
 * system's Reduce motion and Reduce transparency settings.
 *
 * Under the e2e harness's hidden mode it never comes on screen, as the main
 * window does not: `show` only marks it shown and tells the pop-up, whose page
 * still lays out and takes Playwright's input.
 */
import { BrowserWindow, nativeTheme, screen, systemPreferences } from 'electron';
import path from 'node:path';
import { QUICK_ASK_EVENT } from '../../ipc/channels';
import { containNavigation, hiddenForE2e } from './main-window';
import { QUICK_ASK_SIZE, quickAskBounds } from './quick-ask-bounds';
import type { QuickAskPanel } from '../../application/ports/quick-ask-panel';
import type { CaptureTarget, QuickAskLooks } from '../../ipc/quick-ask-api';

export class QuickAskWindow implements QuickAskPanel {
  readonly #window: BrowserWindow;
  #shown = false;
  #passingThrough = true;
  readonly #shownListeners: (() => void)[] = [];

  /** Created hidden, and loaded, ready for the first press (B1). */
  constructor(appDir: string) {
    this.#window = new BrowserWindow({
      type: 'panel',
      ...QUICK_ASK_SIZE,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      title: 'Quick Ask',
      webPreferences: {
        preload: path.join(appDir, 'quick-ask-preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        // Hidden between uses: without this its timers slow down, and the
        // 0.7 s "Started in …" would linger.
        backgroundThrottling: false,
      },
    });
    // Over every Space, full-screen apps included (B2).
    this.#window.setAlwaysOnTop(true, 'pop-up-menu');
    this.#window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.#window.setIgnoreMouseEvents(true, { forward: true });
    containNavigation(this.#window);
    void this.#window.loadFile(path.join(appDir, 'quick-ask', 'index.html'));
  }

  get visible(): boolean {
    return this.#shown;
  }

  /** Whether a click on the window would go to the one underneath; for the e2e suite. */
  get passingThrough(): boolean {
    return this.#passingThrough;
  }

  show(): void {
    if (this.#window.isDestroyed()) return;
    this.#window.setBounds(quickAskBounds(
      screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea,
    ));
    // The pointer is wherever it was; the pop-up says once it is over the slab.
    this.pointerOverSlab(false);
    if (!hiddenForE2e()) {
      this.#window.show();
      this.#window.focus();
    }
    this.#shown = true;
    this.#send(QUICK_ASK_EVENT.shown, looks());
    for (const listener of this.#shownListeners) listener();
  }

  onShown(listener: () => void): void {
    this.#shownListeners.push(listener);
  }

  hide(): void {
    if (!this.#shown || this.#window.isDestroyed()) return;
    this.#shown = false;
    if (!hiddenForE2e()) this.#window.hide();
  }

  /** Hiding is the pop-up's call: it stays while it waits or saves (B4). */
  toggle(): void {
    if (this.#shown) this.#send(QUICK_ASK_EVENT.closeRequested);
    else this.show();
  }

  /** A send turned out to be a capture, into `target`, and it is being written (C4). */
  saving(target: CaptureTarget): void {
    if (!this.#window.isDestroyed()) this.#send(QUICK_ASK_EVENT.saving, target);
  }

  pointerOverSlab(over: boolean): void {
    if (this.#window.isDestroyed()) return;
    this.#passingThrough = !over;
    this.#window.setIgnoreMouseEvents(!over, { forward: true });
  }

  /** Waits for the page on the first press, which can come before it has loaded. */
  #send(channel: string, ...args: unknown[]): void {
    const contents = this.#window.webContents;
    if (contents.isLoading()) contents.once('did-finish-load', () => contents.send(channel, ...args));
    else contents.send(channel, ...args);
  }
}

/** Reduce motion and Reduce transparency, read at each show so a change applies from the next open. */
function looks(): QuickAskLooks {
  return {
    reduceMotion: systemPreferences.getAnimationSettings().prefersReducedMotion,
    reduceTransparency: nativeTheme.prefersReducedTransparency,
  };
}
