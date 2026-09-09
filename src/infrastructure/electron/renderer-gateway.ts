/**
 * Electron's webContents behind the RendererGateway port.
 *
 * Every send is guarded on a live window, and every send is a no-op without
 * one — a session keeps running with no window attached (that is the point of
 * the output buffer), and the alternative would be a null check at each of the
 * fifty call sites.
 *
 * The window is fetched through a callback rather than held, because it is
 * replaced: on macOS the app survives its last window closing and builds a new
 * one when the dock icon is clicked.
 */
import { EVENT } from '../../ipc/channels';
import type { BrowserWindow } from 'electron';
import type { RemoteStatusPayload } from '../../domain/remote/remote-status';
import type { RendererGateway } from '../../application/ports/renderer-gateway';
import type { DiffRequest, FileOpenRequest } from '../../domain/ide/ide-request';

export class ElectronRendererGateway implements RendererGateway {
  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  get attached(): boolean {
    const window = this.getWindow();
    return !!window && !window.isDestroyed();
  }

  // ── Terminal stream ──
  terminalData(sessionId: string, data: string): void {
    this.#send(EVENT.terminalData, sessionId, data);
  }

  processExited(sessionId: string, exitCode: number): void {
    this.#send(EVENT.processExited, sessionId, exitCode);
  }

  // ── Session identity ──
  sessionDetected(tempId: string, realId: string): void {
    this.#send(EVENT.sessionDetected, tempId, realId);
  }

  sessionForked(oldId: string, newId: string): void {
    this.#send(EVENT.sessionForked, oldId, newId);
  }

  // ── Session state ──
  cliBusyState(sessionId: string, busy: boolean): void {
    this.#send(EVENT.cliBusyState, sessionId, busy);
  }

  terminalNotification(sessionId: string, message: string): void {
    this.#send(EVENT.terminalNotification, sessionId, message);
  }

  remoteStatus(sessionId: string, status: RemoteStatusPayload): void {
    this.#send(EVENT.remoteStatus, sessionId, status);
  }

  // ── Lists and chrome ──
  projectsChanged(): void {
    this.#send(EVENT.projectsChanged);
  }

  statusUpdate(text: string, type: string): void {
    this.#send(EVENT.statusUpdate, text, type);
  }

  fullscreenChanged(isFullscreen: boolean): void {
    this.#send(EVENT.fullscreenChanged, isFullscreen);
  }

  fileChanged(filePath: string): void {
    this.#send(EVENT.fileChanged, filePath);
  }

  updaterEvent(type: string, data?: unknown): void {
    this.#send(EVENT.updaterEvent, type, data);
  }

  // ── IDE bridge ──
  openDiff(sessionId: string, diffId: string, request: DiffRequest): void {
    this.#send(EVENT.mcpOpenDiff, sessionId, diffId, request);
  }

  openFile(sessionId: string, request: FileOpenRequest): void {
    this.#send(EVENT.mcpOpenFile, sessionId, request);
  }

  closeAllDiffs(sessionId: string): void {
    this.#send(EVENT.mcpCloseAllDiffs, sessionId);
  }

  closeDiffTab(sessionId: string, diffId: string): void {
    this.#send(EVENT.mcpCloseTab, sessionId, diffId);
  }

  #send(channel: string, ...args: unknown[]): void {
    const window = this.getWindow();
    if (!window || window.isDestroyed()) return;
    window.webContents.send(channel, ...args);
  }
}
