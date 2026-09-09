/**
 * The handful of host capabilities behind the DialogService and SystemGateway
 * ports.
 */
import { app, clipboard, dialog, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import type { DialogService, SystemGateway } from '../../application/ports/desktop';
import type { Logger } from '../../application/ports/logger';

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

  appVersion(): string {
    return app.getVersion();
  }
}
