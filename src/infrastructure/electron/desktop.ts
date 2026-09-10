/**
 * The handful of host capabilities behind the DialogService and SystemGateway
 * ports.
 */
import path from 'node:path';
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

  /**
   * Open the platform's file manager with this path selected.
   *
   * `showItemInFolder` rather than `openPath`: the caller means "show me where
   * this is", and `openPath` on a directory would open it *as* a document —
   * which for a `.app` bundle or a folder with a handler registered is a
   * launch, not a look. It also never runs anything: the worst a bad path can
   * do is open a window on the wrong folder.
   *
   * The path is checked before it gets here (`resolveRevealTarget`); this
   * refuses a relative one as well, because a relative path would be resolved
   * against the main process's cwd and mean something nobody chose.
   */
  revealPath(target: string): void {
    if (typeof target !== 'string' || target === '') return;
    if (!path.isAbsolute(target)) return;
    this.log.info('[system] revealing:', target);
    shell.showItemInFolder(target);
  }

  writeClipboard(text: string): void {
    if (typeof text === 'string') clipboard.writeText(text);
  }

  appVersion(): string {
    return app.getVersion();
  }
}
