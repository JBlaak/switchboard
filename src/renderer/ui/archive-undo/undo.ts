/**
 * Undo on the archive toast, from the renderer's side.
 *
 * Archiving stopped each session and closed its terminal; Undo only brings
 * the rows back. The session on screen when it went is opened again, which
 * resumes it the way opening any stopped session does. Kept free of `window`
 * and the DOM, so it is tested in node with fakes; `actions.ts` hands it the
 * real steps.
 */
import type { RendererEvent } from '../../state/events';
import type { ArchiveUndo } from '../../state/archive-undo-slice';

export interface UndoSteps {
  dispatch(event: RendererEvent): void;
  /** Unarchive one session; false when it could not be. */
  unarchive(sessionId: string): Promise<boolean>;
  /** Open a session again, as a click on its row would. */
  reopen(sessionId: string): Promise<void>;
  /** Reload the list, so the rows come back where they were. */
  reload(): Promise<void>;
  /** The session the Mark done offer is about, if it is up. */
  offeredSession(): string | null;
}

export async function undoArchiveWith(steps: UndoSteps, undo: ArchiveUndo): Promise<void> {
  steps.dispatch({ type: 'archiveUndoClosed', id: undo.id });
  // The offer was about an archive that is no longer one.
  const offered = steps.offeredSession();
  if (offered && undo.sessionIds.includes(offered)) steps.dispatch({ type: 'sessionTaskOfferClosed' });

  const back: string[] = [];
  for (const sessionId of undo.sessionIds) {
    if (await steps.unarchive(sessionId)) back.push(sessionId);
  }
  // The rows slid out and were never told they had arrived anywhere.
  for (const id of undo.leavingIds) steps.dispatch({ type: 'rowLeaving', id, leaving: false });
  await steps.reload();
  if (undo.reopen && back.includes(undo.reopen)) await steps.reopen(undo.reopen);
}
