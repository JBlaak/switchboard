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
import type { WorkingAgent } from '../../domain/terminal/program-status-children';
import type { UpdateNotice } from '../../domain/update/release';
import type { PendingQuestions, QuestionsSettled } from '../../domain/questions/question';
import type { SessionWorkSnapshot } from '../../domain/session-work/model';
import type { PullRequestStatusChange } from '../../domain/session-work/status';
import type { RendererGateway } from '../../application/ports/renderer-gateway';

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

  sessionNeedsAttention(sessionId: string): void {
    this.#send(EVENT.sessionNeedsAttention, sessionId);
  }

  sessionAgents(sessionId: string, agents: WorkingAgent[]): void {
    this.#send(EVENT.sessionAgents, sessionId, agents);
  }

  remoteStatus(sessionId: string, status: RemoteStatusPayload): void {
    this.#send(EVENT.remoteStatus, sessionId, status);
  }

  // ── Questions ──
  questionsAsked(pending: PendingQuestions): void {
    this.#send(EVENT.questionsAsked, pending);
  }

  questionsSettled(settled: QuestionsSettled): void {
    this.#send(EVENT.questionsSettled, settled);
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

  updateAvailable(update: UpdateNotice): void {
    this.#send(EVENT.updateAvailable, update);
  }

  // ── Session work ──
  sessionWorkSnapshot(snapshot: SessionWorkSnapshot): void {
    this.#send(EVENT.sessionWorkSnapshot, snapshot);
  }

  prStatusChanged(change: PullRequestStatusChange): void {
    this.#send(EVENT.prStatusChanged, change);
  }

  #send(channel: string, ...args: unknown[]): void {
    const window = this.getWindow();
    if (!window || window.isDestroyed()) return;
    window.webContents.send(channel, ...args);
  }
}
