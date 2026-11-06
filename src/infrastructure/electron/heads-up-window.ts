/**
 * The 1Password heads-up pop-up's window.
 *
 * Spotlight-like, as Quick Ask's: a non-activating panel over every Space and
 * full-screen app, centred on the display the pointer is on, a quarter of the
 * way down. It takes the keyboard without bringing Switchboard forward, so
 * Enter and Escape reach it from whatever app the user is in, and 1Password's
 * own prompt comes up over that app as it always does.
 *
 * Unlike Quick Ask it does not close when it loses focus: the command waits on
 * an answer, so the pop-up stays until it gets one (a click on it takes the
 * keyboard back).
 */
import {BrowserWindow, screen, systemPreferences} from 'electron';
import path from 'node:path';
import {HEADS_UP_EVENT} from '../../ipc/channels';
import {containNavigation, hiddenForE2e} from './main-window';
import type {HeadsUpPanel} from '../../application/ports/heads-up-panel';
import type {OnePasswordHeadsUp} from '../../domain/onepassword/heads-up';
import type {HeadsUpShown} from '../../ipc/heads-up-api';

export const HEADS_UP_SIZE = {width: 640, height: 290} as const;

export class HeadsUpWindow implements HeadsUpPanel {
    private readonly window: BrowserWindow;
    private showing: OnePasswordHeadsUp | null = null;
    private readonly shownListeners: ((headsUp: OnePasswordHeadsUp) => void)[] = [];

    constructor(appDir: string) {
        this.window = new BrowserWindow({
            type: 'panel',
            ...HEADS_UP_SIZE,
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
            title: '1Password heads-up',
            webPreferences: {
                preload: path.join(appDir, 'heads-up-preload.js'),
                nodeIntegration: false,
                contextIsolation: true,
                backgroundThrottling: false,
            },
        });
        this.window.setAlwaysOnTop(true, 'pop-up-menu');
        this.window.setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true});
        containNavigation(this.window);
        void this.window.loadFile(path.join(appDir, 'heads-up', 'index.html'));
    }

    /** What is on screen; for the e2e suite and a pop-up that has just loaded. */
    public get current(): OnePasswordHeadsUp | null {
        return this.showing;
    }

    public onShown(listener: (headsUp: OnePasswordHeadsUp) => void): void {
        this.shownListeners.push(listener);
    }

    public show(headsUp: OnePasswordHeadsUp): void {
        if (this.window.isDestroyed()) return;
        const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
        this.window.setBounds({
            x: Math.round(area.x + (area.width - HEADS_UP_SIZE.width) / 2),
            y: Math.round(area.y + area.height / 4 - 20),
            ...HEADS_UP_SIZE,
        });
        this.showing = headsUp;
        // Made at the first heads-up, so it may still be loading: it comes on
        // screen once the page has what to show, never as an empty pane.
        this.whenLoaded(() => {
            if (this.showing !== headsUp) return;
            this.resend();
            if (!hiddenForE2e()) {
                this.window.show();
                this.window.focus();
            }
            for (const listener of this.shownListeners) listener(headsUp);
        });
    }

    public hide(): void {
        this.showing = null;
        if (this.window.isDestroyed() || hiddenForE2e()) return;
        this.window.hide();
    }

    /** Tell the page what is on screen; again when it says it has (re)loaded. */
    public resend(): void {
        if (!this.showing || this.window.isDestroyed()) return;
        const shown: HeadsUpShown = {
            headsUp: this.showing,
            reduceMotion: systemPreferences.getAnimationSettings().prefersReducedMotion,
        };
        this.whenLoaded(() => this.window.webContents.send(HEADS_UP_EVENT.shown, shown));
    }

    private whenLoaded(run: () => void): void {
        const contents = this.window.webContents;
        if (contents.isLoading()) contents.once('did-finish-load', run);
        else run();
    }
}
