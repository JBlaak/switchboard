/**
 * electron-updater behind the Updater port.
 *
 * Only real in a packaged build: an unpackaged one has no update feed, so the
 * port answers `enabled: false` and every method is a no-op rather than the
 * caller having to know which build it is in.
 *
 * Required lazily. electron-updater resolves app paths relative to its own
 * location and is left out of the bundle for that reason, so importing it
 * unconditionally would break the development build.
 */
import { app } from 'electron';
import type { Logger } from '../../application/ports/logger';
import type { UpdateCheckResult, Updater } from '../../application/ports/desktop';
import type { Timers } from '../../application/ports/clock';

type AutoUpdater = typeof import('electron-updater').autoUpdater;

/** The progress and result events the UI narrates. */
const FORWARDED_EVENTS = [
  'checking-for-update',
  'update-available',
  'update-not-available',
  'download-progress',
  'update-downloaded',
] as const;

/** What the renderer calls each of them. */
const EVENT_NAMES: Record<string, string> = {
  'checking-for-update': 'checking',
  'update-available': 'update-available',
  'update-not-available': 'update-not-available',
  'download-progress': 'download-progress',
  'update-downloaded': 'update-downloaded',
};

export interface UpdaterDeps {
  log: Logger;
  /** Where an event goes; the renderer turns it into a status line and a toast. */
  onEvent(type: string, data?: unknown): void;
}

export class ElectronUpdater implements Updater {
  readonly enabled: boolean;
  readonly #updater: AutoUpdater | null = null;

  constructor(private readonly deps: UpdaterDeps) {
    // FORCE_UPDATER lets the update flow be exercised without packaging.
    this.enabled = app.isPackaged || !!process.env.FORCE_UPDATER;
    if (!this.enabled) return;

    const updater = (require('electron-updater') as typeof import('electron-updater')).autoUpdater;
    updater.logger = deps.log as unknown as AutoUpdater['logger'];
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    if (!app.isPackaged) updater.forceDevUpdateConfig = true;

    for (const event of FORWARDED_EVENTS) {
      updater.on(event, (data: unknown) => {
        const type = EVENT_NAMES[event] ?? event;
        deps.log.info(`[updater] ${type}`, data ?? '');
        deps.onEvent(type, data);
      });
    }
    updater.on('error', (err: Error) => {
      deps.log.error('[updater] error:', err?.message || String(err));
      deps.onEvent('error', { message: err?.message || String(err) });
    });

    this.#updater = updater;
  }

  async check(): Promise<UpdateCheckResult> {
    if (!this.#updater) return { available: false, dev: true };
    const result = await this.#updater.checkForUpdates();
    return { available: !!result?.updateInfo, ...result };
  }

  async download(): Promise<void> {
    await this.#updater?.downloadUpdate();
  }

  install(): void {
    this.#updater?.quitAndInstall();
  }

  /** Check now, and then on a long interval for an app left running for days. */
  startPeriodicChecks(timers: Timers, options: { initialDelayMs: number; intervalMs: number }): void {
    if (!this.#updater) return;
    const check = (): void => {
      void this.check().catch((err: Error) =>
        this.deps.log.error('[updater] check failed:', err?.message || String(err)));
    };
    timers.setTimeout(check, options.initialDelayMs);
    timers.setInterval(check, options.intervalMs);
  }
}
