/**
 * Noticing a newer release and installing it when asked.
 *
 * Checks shortly after launch and every few hours after, and tells the
 * renderer once per new version found. Nothing downloads until the user clicks
 * Install: the notice is the whole of the interruption.
 *
 * A failed check is logged and forgotten — offline, rate-limited, or no
 * release yet are all ordinary, and the next check tries again.
 */
import { availableUpdate } from '../../domain/update/release';
import type { AvailableUpdate, UpdateNotice } from '../../domain/update/release';
import type { Timers } from '../ports/clock';
import type { Logger } from '../ports/logger';
import type { RendererGateway } from '../ports/renderer-gateway';
import type { AppInstaller, ReleaseFeed } from '../ports/updates';

/** How long after launch the first check waits, so it stays out of start-up. */
export const FIRST_CHECK_MS = 10 * 1000;
/** How often the release feed is asked again. */
export const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

export class UpdateService {
  #available: AvailableUpdate | null = null;
  #installing = false;

  constructor(private readonly deps: {
    feed: ReleaseFeed;
    installer: AppInstaller;
    renderer: Pick<RendererGateway, 'updateAvailable'>;
    timers: Timers;
    log: Logger;
    currentVersion: string;
    arch: string;
  }) {}

  start(): void {
    const { timers } = this.deps;
    timers.setTimeout(() => { void this.check(); }, FIRST_CHECK_MS);
    timers.setInterval(() => { void this.check(); }, CHECK_EVERY_MS);
  }

  async check(): Promise<void> {
    const { feed, renderer, log, currentVersion, arch } = this.deps;
    let found: AvailableUpdate | null;
    try {
      const release = await feed.latest();
      found = release ? availableUpdate(release, currentVersion, arch) : null;
    } catch (err) {
      log.warn('[update] check failed:', (err as Error).message);
      return;
    }
    if (!found || found.version === this.#available?.version) return;

    log.info(`[update] ${found.version} is available (running ${currentVersion})`);
    this.#available = found;
    renderer.updateAvailable(this.notice()!);
  }

  /** The update waiting to be installed, for a renderer that loaded after the event. */
  notice(): UpdateNotice | null {
    const update = this.#available;
    if (!update) return null;
    return {
      version: update.version,
      pageUrl: update.pageUrl,
      installable: update.downloadUrl !== null && this.deps.installer.canInstall(),
    };
  }

  /** Install the waiting update. False when it could not; on success the app quits instead. */
  async install(): Promise<boolean> {
    const { installer, log } = this.deps;
    const url = this.#available?.downloadUrl;
    if (!url || this.#installing || !installer.canInstall()) return false;

    this.#installing = true;
    try {
      await installer.install(url);
      return true;
    } catch (err) {
      log.error('[update] install failed:', (err as Error).message);
      return false;
    } finally {
      this.#installing = false;
    }
  }
}
