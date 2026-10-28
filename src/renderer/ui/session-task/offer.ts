/**
 * The archive's Mark done offer (#250), from the renderer's side.
 *
 * Archiving a session answers `markDone` only when main says so: you archived
 * it, it works on a task, and every PR it opened is merged (#247, #248).
 * Nothing is shown otherwise. D marks the task done; Leave it puts the offer
 * away. Kept free of `window` and the DOM, so both are tested in node with
 * fakes; `actions.ts` hands it the real steps.
 */
import type { RendererEvent } from '../../state/events';
import type { TaskChange, TaskUpdateResult, MarkDoneOffer } from '../../../domain/tasks/surface';

/** What archiving a row answered, as far as the offer goes. */
export interface ArchiveAnswer {
  markDone?: MarkDoneOffer;
}

/** The events an archive's answer brings: the offer when main made one, nothing otherwise. */
export function archiveAnswerEvents(sessionId: string, answer: ArchiveAnswer | null | undefined): RendererEvent[] {
  return answer?.markDone ? [{ type: 'taskMarkDoneOffered', sessionId, taskId: answer.markDone.taskId }] : [];
}

export interface OfferSteps {
  dispatch(event: RendererEvent): void;
  updateTask(taskId: string, change: TaskChange): Promise<TaskUpdateResult>;
  /** Ask main for the task again, so every surface shows it Done. */
  refresh(taskId: string): void;
}

/** D (Mark done) or Leave it on the offer. */
export async function answerOfferWith(
  steps: OfferSteps, offer: { sessionId: string; taskId: string }, choice: 'done' | 'leave',
): Promise<void> {
  steps.dispatch({ type: 'sessionTaskOfferClosed' });
  if (choice === 'leave') return;
  await markDoneWith(steps, offer.taskId);
}

/** Mark a task done, because you pressed for it: the offer's D, or the Task tab's Mark done. */
export async function markDoneWith(steps: OfferSteps, taskId: string): Promise<void> {
  steps.dispatch({ type: 'sessionTaskActionRequested', taskId, action: 'done' });
  let error: string | null;
  try {
    error = changeError(await steps.updateTask(taskId, { kind: 'done' }));
  } catch (err) {
    error = (err as Error).message || 'Could not mark it done';
  }
  steps.dispatch({ type: 'sessionTaskActionAnswered', taskId, action: 'done', error });
  if (!error) steps.refresh(taskId);
}

/** Why a change did not go through, or null when it did (or is queued to). */
export function changeError(result: TaskUpdateResult): string | null {
  switch (result.kind) {
    case 'ok':
    case 'queued':
      return null;
    case 'off': return 'BlaakTasks is off';
    case 'notSetUp': return 'BlaakTasks is not set up in Claude Code';
    case 'unreachable': return 'Couldn’t reach BlaakTasks';
    case 'failed': return result.reason;
  }
}
