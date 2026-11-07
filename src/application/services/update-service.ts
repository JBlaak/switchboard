/**
 * Noticing a newer release and installing it when asked.
 *
 * Checks shortly after launch and every few hours after, and tells the
 * renderer once per new version found. Nothing downloads until the user clicks
 * Install: the notice is the whole of the interruption.
 *
 * A failed check is logged and forgotten — offline, rate-limited, or no
 * release yet are all ordinary, and the next check tries again.
 *
 * An install tells the renderer each step as it starts (download, unpack,
 * check, restart) and the download as it goes, so the footer is never left
 * on a frozen "Installing…". Before quitting it notes which version it is
 * becoming; the next launch reads that back and says whether it arrived.
 */
import {availableUpdate} from '../../domain/update/release';
import {downloadWorthReporting, updateOutcome} from '../../domain/update/progress';
import type {AvailableUpdate, UpdateNotice} from '../../domain/update/release';
import type {InstallProgress, InstallResult, InstallStep, UpdateOutcome} from '../../domain/update/progress';
import type {Timers} from '../ports/clock';
import type {Logger} from '../ports/logger';
import type {RendererGateway} from '../ports/renderer-gateway';
import type {AppInstaller, PendingUpdateStore, ReleaseFeed} from '../ports/updates';

/** How long after launch the first check waits, so it stays out of start-up. */
export const FIRST_CHECK_MS = 10 * 1000;
/** How often the release feed is asked again. */
export const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

export class UpdateService {
    private available: AvailableUpdate | null = null;
    private installing = false;
    private settled: Promise<UpdateOutcome | null> = Promise.resolve(null);

    constructor(
        private readonly deps: {
            feed: ReleaseFeed;
            installer: AppInstaller;
            pending: PendingUpdateStore;
            renderer: Pick<RendererGateway, 'updateAvailable' | 'updateProgress'>;
            timers: Timers;
            log: Logger;
            currentVersion: string;
            arch: string;
        },
    ) {}

    public start(): void {
        const {timers} = this.deps;
        this.settled = this.settlePending();
        timers.setTimeout(() => {
            void this.check();
        }, FIRST_CHECK_MS);
        timers.setInterval(() => {
            void this.check();
        }, CHECK_EVERY_MS);
    }

    public async check(): Promise<void> {
        const {feed, renderer, log, currentVersion, arch} = this.deps;
        let found: AvailableUpdate | null;
        try {
            const release = await feed.latest();
            found = release ? availableUpdate(release, currentVersion, arch) : null;
        } catch (err) {
            log.warn('[update] check failed:', (err as Error).message);
            return;
        }
        if (!found || found.version === this.available?.version) return;

        log.info(`[update] ${found.version} is available (running ${currentVersion})`);
        this.available = found;
        renderer.updateAvailable(this.notice()!);
    }

    /** The update waiting to be installed, for a renderer that loaded after the event. */
    public notice(): UpdateNotice | null {
        const update = this.available;
        if (!update) return null;
        return {
            version: update.version,
            pageUrl: update.pageUrl,
            installable: update.downloadUrl !== null && this.deps.installer.canInstall(),
        };
    }

    /** How the install before this launch went; null when there was none. */
    public outcome(): Promise<UpdateOutcome | null> {
        return this.settled;
    }

    /**
     * Install the waiting update, telling the renderer each step. On success
     * the app quits before the answer arrives; a failure names the step.
     */
    public async install(): Promise<InstallResult> {
        const {installer, pending, renderer, log, currentVersion} = this.deps;
        const update = this.available;
        if (!update?.downloadUrl || !installer.canInstall()) {
            return {ok: false, failure: {step: 'downloading', reason: 'There is no update this app can install.'}};
        }
        if (this.installing) {
            return {ok: false, failure: {step: 'downloading', reason: 'An install is already under way.'}};
        }

        this.installing = true;
        // Held in an object: the listener moves it on from inside callbacks.
        const at: {step: InstallStep} = {step: 'downloading'};
        let lastReported: number | null = null;
        const report = (progress: InstallProgress): void => {
            at.step = progress.step;
            renderer.updateProgress(progress);
        };
        try {
            const bundle = await installer.prepare(update.downloadUrl, {
                downloaded: (received, total) => {
                    if (!downloadWorthReporting(lastReported, received, total)) return;
                    lastReported = received;
                    report({step: 'downloading', received, total});
                },
                unpacking: () => report({step: 'unpacking'}),
                checking: () => report({step: 'checking'}),
            });
            report({step: 'restarting'});
            // Only for the message after the restart: an install without it still installs.
            await pending.write({from: currentVersion, to: update.version}).catch((err: Error) => {
                log.warn('[update] could not note the pending update:', err.message);
            });
            installer.swapAndRestart(bundle);
            return {ok: true};
        } catch (err) {
            const reason = (err as Error).message;
            log.error(`[update] install failed while ${at.step}:`, reason);
            if (at.step === 'restarting') await pending.take().catch(() => null);
            return {ok: false, failure: {step: at.step, reason}};
        } finally {
            this.installing = false;
        }
    }

    private async settlePending(): Promise<UpdateOutcome | null> {
        const {pending, log, currentVersion} = this.deps;
        try {
            const last = await pending.take();
            if (!last) return null;
            const outcome = updateOutcome(last, currentVersion);
            if (outcome.kind === 'updated') log.info(`[update] updated from ${last.from} to ${currentVersion}`);
            else log.warn(`[update] ${last.to} was installed, but ${currentVersion} launched`);
            return outcome;
        } catch (err) {
            log.warn('[update] could not read the pending update:', (err as Error).message);
            return null;
        }
    }
}
