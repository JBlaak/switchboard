/**
 * The main process, start to finish.
 *
 * Bootstrap only: build the container, register the IPC handlers, open a
 * window, start the background work, and shut it all down cleanly. Every
 * decision this used to make is now behind a service — what is left is the
 * order things happen in, which is the one thing an entry point should own.
 */
import {app, dialog, globalShortcut, powerMonitor} from 'electron';
import log from 'electron-log';
import {buildContainer, isolateUserDataIfRequested} from './composition-root';
import {registerIpcHandlers} from './ipc';
import {buildApplicationMenu} from '../infrastructure/electron/app-menu';
import {createMainWindow, hiddenForE2e} from '../infrastructure/electron/main-window';
import {systemTimers} from '../infrastructure/system/timers';
import {normaliseAppIcon} from '../domain/settings/app-icon';
import {normaliseAppearance} from '../domain/settings/appearance';
import type {Container} from './composition-root';
import type {VmChoice} from '../domain/merge-manager/merging-host';

// Must happen before anything reads a path off `app`.
isolateUserDataIfRequested();

log.transports.file.level = app.isPackaged ? 'info' : 'debug';
log.transports.console.level = app.isPackaged ? 'info' : 'debug';

// Dev-only live reload. A bare require so the dependency stays out of the
// packaged bundle's import graph; esbuild keeps it external.
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- see above
    require('electron-reloader')(module, {watchRenderer: true});
} catch {
    // Not installed, or a packaged build.
}

/**
 * Only one instance may run.
 *
 * Replacing the AppImage while Switchboard is running makes the OS spawn the
 * new binary, which would otherwise initialise a second process and leave the
 * first one's sessions orphaned or killed. The second launch quits immediately;
 * the first brings its window to the front.
 */
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    main();
}

function main(): void {
    const container = buildContainer();

    // An accessory app gets no Dock icon and is never made active, so an e2e
    // run's apps do not take focus from whatever the user is typing in.
    if (hiddenForE2e() && process.platform === 'darwin') app.setActivationPolicy('accessory');

    app.on('second-instance', () => {
        const window = container.getWindow();
        if (!window) return;
        if (window.isMinimized()) window.restore();
        window.focus();
    });

    // Listening at all is the point: without a listener Electron quits when the
    // last window closes, and a Mac app stays running in the Dock instead.
    app.on('window-all-closed', () => {});

    // Quitting with landed PRs in a Switchboard lane asks to hand merging off
    // to a VM first (#442); asked once per quit, and never in the e2e suite.
    let mergingAsked = false;
    app.on('before-quit', (event) => {
        if (!mergingAsked && process.env.SWITCHBOARD_E2E !== '1' && container.getWindow()) {
            const prompt = container.mergingHost.quitPrompt();
            if (prompt) {
                mergingAsked = true;
                event.preventDefault();
                void askHandOffOnQuit(container, prompt).then((quit) => {
                    if (quit) app.quit();
                    else mergingAsked = false;
                });
                return;
            }
        }
        // Phone access first. The advertisement goes synchronously, so no
        // `dns-sd` outlives the app; the phones are told "going away" while the
        // windows close, and a connection still closing when the process ends
        // goes with it. Not awaited: holding the quit back with preventDefault
        // leaves a SIGTERM'd app running with no window.
        container.lanWatcher.stop();
        container.phoneAdvertiser.withdraw();
        container.phoneAccess
            .shutdown()
            .catch((err: Error) => container.log.warn('[phone] shutdown failed:', err.message));
        container.projectsWatcher.stop();
        container.questionHook.stop();
        // Close the VM links first: their sessions keep running on the VM.
        container.agents.shutdown();
        // Whatever ends from here on was running when the app quit, and comes back.
        container.sessionRestore.freeze();
        container.lifecycle.terminateAll();
    });

    // After the windows are gone, so nothing is mid-query when the handle closes.
    app.on('will-quit', () => {
        globalShortcut.unregisterAll();
        container.close();
    });

    void app.whenReady().then(() => start(container));
}

/**
 * "Hand off merging to <VM>?" on quit (#442): one button per VM, the last
 * choice first. A refused hand-off says why and how to fix it, and lets the
 * quit go on or not. Answers whether to quit.
 */
async function askHandOffOnQuit(
    container: Container,
    prompt: {vm: VmChoice; vms: readonly VmChoice[]},
): Promise<boolean> {
    const vms = [prompt.vm, ...prompt.vms.filter((vm) => vm.key !== prompt.vm.key)];
    const window = container.getWindow();
    const options = {
        type: 'question' as const,
        message: `Hand off merging to ${prompt.vm.name}?`,
        detail:
            'Landed pull requests wait in a Switchboard lane. On a VM they keep moving and their fix errands keep ' +
            'running while this Mac is closed; otherwise they pause until Switchboard runs again.',
        buttons: [...vms.map((vm) => `Hand Off to ${vm.name}`), 'Quit Without', 'Cancel'],
        defaultId: 0,
        cancelId: vms.length + 1,
    };
    const answer = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
    if (answer.response === vms.length + 1) return false;
    if (answer.response === vms.length) return true;
    const handed = await container.mergingHost.handOff(vms[answer.response].key);
    if (handed.ok) return true;
    const failed = {
        type: 'warning' as const,
        message: 'Merging was not handed off',
        detail: handed.reason + (handed.fix ? `\n\n${handed.fix}` : ''),
        buttons: ['Quit Anyway', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
    };
    const again = window ? await dialog.showMessageBox(window, failed) : await dialog.showMessageBox(failed);
    return again.response === 0;
}

async function start(container: Container): Promise<void> {
    // Before the window, so the first session the renderer restores already gets
    // the question hook. A server that fails to start costs only the hook:
    // sessions launch without it and ask in their own terminal.
    try {
        await container.questionHook.start();
    } catch (err) {
        container.log.error('[questions] hook server failed to start:', (err as Error).message);
    }

    registerIpcHandlers(container);
    buildApplicationMenu();

    // Before the window: the chrome's overlay colours are picked at creation, and
    // a renderer that first paints in the wrong scheme flashes on every launch.
    container.appearance.apply(normaliseAppearance(container.settings.global().appearance));
    container.appIcon.apply(normaliseAppIcon(container.settings.global().appIcon));
    container.setWindowOpener((options) => openWindow(container, options));
    // A shutdown may take the sessions down before the app hears it is quitting;
    // they were still running, so they come back after the reboot.
    powerMonitor.on('shutdown', () => container.sessionRestore.freeze());
    // Before the window, so its first poll already finds them running.
    void restoreSessions(container);
    openWindow(container);
    // After the main window, which stays the app's first.
    if (container.settings.quickAskEnabled()) container.prepareQuickAsk();
    container.quickAskHotkey.apply();

    container.projectsWatcher.start();
    container.schedules.ensureCreatorCommand();
    container.schedules.start();
    // Only an installed build has a version worth comparing; a dev run would
    // always be "behind" whatever is released.
    if (app.isPackaged) container.updates.start();
    // The CI watch asks the user's own `gh` about real PRs; the end-to-end suite
    // must never reach GitHub, and drives the dots and cards by pushing instead.
    if (process.env.SWITCHBOARD_E2E !== '1') {
        container.prWatch.start();
        // The merge queue (#315) reads GitHub too; the suite pushes its queues instead.
        container.mergeQueueWatch.start();
        // The Merge manager (#434) reads every landed PR's lane on GitHub, here
        // or, once merging was handed off, on the VM it follows (#442).
        container.mergingHost.start();
        // The managers' inbox (#413) asks Bugsnag and GitHub; the suite seeds its items instead.
        container.inbox.start();
        // …and follows the PRs of the issues started from it (#415).
        container.issueManager.start();
        // Following a Fix's PR (#414) asks GitHub and Bugsnag too.
        container.bugFix.start();
    }

    // Phone access, if it was left on (#194). Its failures land in its own
    // state, which Settings shows; only a bug gets as far as this catch.
    container.phoneAccess.start().catch((err: Error) => container.log.error('[phone] failed to start:', err.message));
    container.lanWatcher.start();
    // BlaakTasks, when a URL is set: the linked sessions' PRs catch up (#248).
    container.tasks.start();

    // A migration that recreated the search index leaves it empty even though the
    // session cache is intact, so the index alone has to be refilled.
    if (container.searchIndex.wasRecreated()) container.sessionIndex.rebuild();

    // macOS keeps the app alive after its last window closes. The Quick Ask
    // pop-up is a window too, but not one to come back to.
    app.on('activate', () => {
        if (!container.getWindow()) openWindow(container);
    });
}

/** Resume the local sessions a quit, a crash or a reboot cut off. */
async function restoreSessions(container: Container): Promise<void> {
    try {
        await container.sessionRestore.restore();
    } catch (err) {
        container.log.error('[restore] failed:', (err as Error).message);
    }
}

function openWindow(container: Container, {inactive = false} = {}): void {
    const window = createMainWindow({
        timers: systemTimers,
        appDir: __dirname,
        inactive,
        savedBounds: () => container.settings.global().windowBounds,
        saveBounds: (bounds) =>
            container.settings.updateGlobal((settings) => {
                settings.windowBounds = bounds;
            }),
        onFullscreenChanged: (isFullscreen) => container.renderer.fullscreenChanged(isFullscreen),
        // Back at the window: what CI did meanwhile shows now, not within the minute (W1).
        onFocus: () => {
            container.prWatch.focused();
            container.mergeQueueWatch.focused();
            container.mergingHost.focused();
        },
        onClosed: () => {
            // On macOS the app stays in the dock after its last window closes. Kill
            // the sessions anyway: orphaned `claude` processes would otherwise
            // accumulate in the background with no way for the user to reach them.
            container.lifecycle.terminateAll();
            container.setWindow(null);
        },
    });
    container.setWindow(window);
}
