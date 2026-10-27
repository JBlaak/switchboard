/**
 * The handful of host capabilities behind the DialogService, SystemGateway,
 * AppearanceGateway and AppIconGateway ports.
 */
import path from 'node:path';
import { app, clipboard, dialog, nativeImage, nativeTheme, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import type {
  AppIconGateway, AppearanceGateway, DialogService, SystemGateway,
} from '../../application/ports/desktop';
import type { Logger } from '../../application/ports/logger';
import type { AppIcon } from '../../domain/settings/app-icon';
import type { Appearance } from '../../domain/settings/appearance';

export class ElectronDialogService implements DialogService {
  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  async chooseDirectory(title: string): Promise<string | null> {
    const window = this.getWindow();
    if (!window || window.isDestroyed()) return null;
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory', 'createDirectory'],
      title,
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  }
}

export class ElectronSystemGateway implements SystemGateway {
  constructor(private readonly log: Logger) {}

  /**
   * Open a link in the user's browser.
   *
   * Only http(s). These URLs come out of terminal output, and handing an
   * arbitrary scheme to the OS is how a link in a session's output gets to run
   * something.
   */
  async openExternal(url: string): Promise<void> {
    if (!/^https?:\/\//i.test(url)) return;
    this.log.info('[system] opening externally:', url);
    await shell.openExternal(url);
  }

  writeClipboard(text: string): void {
    if (typeof text === 'string') clipboard.writeText(text);
  }

  writeClipboardImage(png: Uint8Array): void {
    if (!(png instanceof Uint8Array)) return;
    const image = nativeImage.createFromBuffer(Buffer.from(png));
    if (!image.isEmpty()) clipboard.writeImage(image);
  }

  appVersion(): string {
    return app.getVersion();
  }
}

/**
 * The colour scheme, via `nativeTheme.themeSource`.
 *
 * Setting it is all it takes: Chromium re-evaluates `prefers-color-scheme` in
 * every renderer and fires `nativeTheme`'s 'updated', which the window chrome
 * listens to for the parts CSS cannot reach.
 */
export class ElectronAppearanceGateway implements AppearanceGateway {
  apply(mode: Appearance): void {
    nativeTheme.themeSource = mode;
  }
}

/**
 * The Dock tile's icon, via `app.dock.setIcon`.
 *
 * It only lasts while the app runs, so it is applied at every launch. Until a
 * different icon is asked for, the tile shows the bundle's own icon, which is
 * the Switchboard one: asking for that first changes nothing, so a packaged
 * app keeps the crisp .icns rather than a PNG standing in for it.
 */
export class ElectronAppIconGateway implements AppIconGateway {
  /** The icon on the tile; 'switchboard' until a different one is set. */
  private shown: AppIcon = 'switchboard';

  /** `dir` holds one PNG per icon, already inset the way the Dock expects. */
  constructor(private readonly dir: string, private readonly log: Logger) {}

  apply(icon: AppIcon): void {
    const dock = app.dock;
    if (!dock || icon === this.shown) return;
    const image = nativeImage.createFromPath(path.join(this.dir, `${icon}.png`));
    if (image.isEmpty()) {
      this.log.error('[app-icon] no Dock icon for', icon, 'in', this.dir);
      return;
    }
    dock.setIcon(image);
    this.shown = icon;
  }
}
