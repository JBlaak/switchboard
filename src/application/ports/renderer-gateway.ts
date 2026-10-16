/**
 * Everything the main process pushes at the UI, in one place.
 *
 * These are events, not answers: the renderer asks its questions through IPC
 * handlers, but a session's output, a connection's progress and a fork it never
 * requested all arrive unprompted. Naming them as methods is what keeps
 * `webContents.send('some-string', …)` — and the window it needs — out of the
 * session lifecycle and the SSH supervisor.
 */
import type { RemoteStatusPayload } from '../../domain/remote/remote-status';
import type { WorkingAgent } from '../../domain/terminal/program-status-children';
import type { UpdateNotice } from '../../domain/update/release';
import type { PendingQuestions, QuestionsSettled } from '../../domain/questions/question';

export interface RendererGateway {
  /** True while there is a window listening; every send is a no-op without one. */
  readonly attached: boolean;

  // ── Terminal stream ──
  terminalData(sessionId: string, data: string): void
  processExited(sessionId: string, exitCode: number): void

  // ── Session identity ──
  /** A fork or plan-accept re-keyed a running session. */
  sessionForked(oldId: string, newId: string): void

  // ── Session state ──
  cliBusyState(sessionId: string, busy: boolean): void
  terminalNotification(sessionId: string, message: string): void
  /** The CLI is blocked on the user — a permission prompt, a question, a login. */
  sessionNeedsAttention(sessionId: string): void
  /** The agents the session has working changed; an empty list means none. */
  sessionAgents(sessionId: string, agents: WorkingAgent[]): void
  remoteStatus(sessionId: string, status: RemoteStatusPayload): void

  // ── Questions ──
  /** A session is blocked on questions Switchboard can answer. */
  questionsAsked(pending: PendingQuestions): void
  /** Those questions were answered here, or withdrawn (the CLI asks in the terminal). */
  questionsSettled(settled: QuestionsSettled): void

  // ── Lists and chrome ──
  projectsChanged(): void
  statusUpdate(text: string, type: string): void
  fullscreenChanged(isFullscreen: boolean): void
  /** A newer release was found. */
  updateAvailable(update: UpdateNotice): void
}
