/**
 * The archive's offer (#250): "Mark “<title>” done?" with D and Leave it,
 * shown only when main answered the archive with it (you archived the
 * session, and every PR it opened is merged). Nothing shows otherwise.
 *
 * It floats at the foot of the main area and takes the focus as it comes, so
 * D and Esc reach it rather than a terminal.
 */
import { useLayoutEffect, useRef } from 'react';
import type { JSX, KeyboardEvent } from 'react';
import { shallowEqual } from '../../state/store';
import { offerQuestion, taskName } from '../../state/session-task-slice';
import { useStore } from '../use-store';
import { answerMarkDoneOffer } from './actions';

export function MarkDoneOffer(): JSX.Element | null {
  const offer = useStore(state => {
    const { offer: shown, tasks } = state.sessionTask;
    if (!shown) return null;
    const detail = tasks[shown.taskId]?.detail ?? null;
    return {
      taskId: shown.taskId, question: offerQuestion(detail), title: detail?.title ?? null, name: detail ? taskName(detail) : null,
    };
  }, shallowEqual);
  const primary = useRef<HTMLButtonElement>(null);
  const taskId = offer?.taskId ?? null;

  useLayoutEffect(() => {
    if (taskId) primary.current?.focus({ preventScroll: true });
  }, [taskId]);

  if (!offer) return null;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // The offer's keys are its own (see `app/shortcuts`).
    if (e.key === 'd' || e.key === 'D' || e.key === 'Escape') (e.nativeEvent as Event & { _handled?: boolean })._handled = true;
    if (e.key === 'd' || e.key === 'D') {
      e.preventDefault();
      e.stopPropagation();
      void answerMarkDoneOffer('done');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      void answerMarkDoneOffer('leave');
    }
  };

  return (
    <div className="st-offer" role="alertdialog" aria-label="Mark the task done?" onKeyDown={onKeyDown} data-testid="task-done-offer">
      <div className="st-offer-text">
        <span className="st-offer-lead">Session archived. Every PR it opened is merged.</span>
        {/* The title gives way, never the question around it. */}
        <span className="st-offer-question" title={offer.title ?? undefined} aria-label={offer.question}>
          {offer.name
            ? <>Mark “<span className="st-offer-title">{offer.name}</span>” done?</>
            : offer.question}
        </span>
      </div>
      <div className="st-offer-actions">
        <button ref={primary} type="button" className="sw-btn is-primary" onClick={() => void answerMarkDoneOffer('done')}>
          <kbd className="st-offer-kbd">D</kbd> Mark done
        </button>
        <button type="button" className="sw-btn" onClick={() => void answerMarkDoneOffer('leave')}>Leave it</button>
      </div>
    </div>
  );
}
