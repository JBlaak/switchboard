/**
 * Everything the main process pushes at the UI, in one place.
 *
 * These are events, not answers: the renderer asks its questions through IPC
 * handlers, but a session's output, a connection's progress and a fork it never
 * requested all arrive unprompted. Naming them as methods is what keeps
 * `webContents.send('some-string', …)` — and the window it needs — out of the
 * session lifecycle, the SSH supervisor and the MCP bridge.
 */
import type { RemoteStatusPayload } from '../../domain/remote/remote-status';
import type { DiffRequest, FileOpenRequest } from '../../domain/ide/ide-request';

export interface RendererGateway {
  /** True while there is a window listening; every send is a no-op without one. */
  readonly attached: boolean;

  // ── Terminal stream ──
  terminalData(sessionId: string, data: string): void
  processExited(sessionId: string, exitCode: number): void

  // ── Session identity ──
  /** A new session's real id, once Claude has written it. */
  sessionDetected(tempId: string, realId: string): void
  /** A fork or plan-accept re-keyed a running session. */
  sessionForked(oldId: string, newId: string): void

  // ── Session state ──
  cliBusyState(sessionId: string, busy: boolean): void
  terminalNotification(sessionId: string, message: string): void
  remoteStatus(sessionId: string, status: RemoteStatusPayload): void

  // ── Lists and chrome ──
  projectsChanged(): void
  statusUpdate(text: string, type: string): void
  fullscreenChanged(isFullscreen: boolean): void
  fileChanged(filePath: string): void
  updaterEvent(type: string, data?: unknown): void

  // ── IDE bridge (MCP) ──
  openDiff(sessionId: string, diffId: string, request: DiffRequest): void
  openFile(sessionId: string, request: FileOpenRequest): void
  closeAllDiffs(sessionId: string): void
  closeDiffTab(sessionId: string, diffId: string): void
}
