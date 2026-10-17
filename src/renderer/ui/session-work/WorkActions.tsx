/**
 * What can be handed to Claude from the selected item, and how it is going:
 * the row of action buttons beside its title, and the activity card under it.
 *
 * Every button types a prompt into the session's terminal (A1), so they all
 * wait on the session: while it is not running they are disabled and say why,
 * and while an action is queued or with Claude its button says so. The card
 * is grey while the action waits (with Cancel), amber while Claude works on it,
 * blue with Ship it's four steps, and red once Claude gave up.
 */
import type { JSX } from 'react';
import { useStore } from '../use-store';
import { cancelWorkAction, openOnGitHub, requestWorkAction, viewInTerminal } from './actions';
import { activityCard, itemButtons } from './describe';
import type { SessionWorkPage } from '../../state/session-work-slice';
import type { SessionWorkItem } from '../../../domain/session-work/model';
import type { ShipStepState } from '../../../domain/session-work/ship';

export function ActionRow({ page, item }: { page: SessionWorkPage; item: SessionWorkItem }): JSX.Element | null {
  const running = useStore(state => state.view.activePtyIds.has(page.sessionId));
  if (!page.snapshot) return null;
  const buttons = itemButtons(item, { gh: page.snapshot.gh, running, pending: page.pendingAction });
  if (!buttons.length) return null;

  return (
    <div className="sw-actions" role="group" aria-label="Actions">
      {buttons.map(button => (
        <button
          key={button.id}
          type="button"
          className={'sw-btn' + (button.tone === 'plain' ? '' : ' is-' + button.tone)}
          title={button.disabled ?? button.hint}
          // aria-disabled rather than disabled, so the reason stays reachable as the title.
          aria-disabled={button.disabled ? true : undefined}
          onClick={() => {
            if (button.disabled) return;
            if (button.id === 'github') {
              if (item.kind === 'pr') openOnGitHub(item.pr.url);
              return;
            }
            void requestWorkAction(item.id, button.id);
          }}
        >
          {button.label}
        </button>
      ))}
    </div>
  );
}

const GLYPHS: Record<ShipStepState, string> = { done: '✓', running: '•', todo: '', failed: '✕' };

export function ActivityCardView({ item }: { item: SessionWorkItem }): JSX.Element | null {
  const now = useStore(state => state.sessionWork.now);
  const card = activityCard(item, now);
  if (!card) return null;

  return (
    <div className={'sw-activity is-' + card.tone} role="status" data-testid="session-work-activity">
      <div className="sw-activity-head">
        <span className="sw-activity-title">{card.title}</span>
        <span className="sw-activity-detail">{card.detail}</span>
        <span className="sw-activity-actions">
          {card.cancelId && (
            <button
              type="button"
              className="sw-btn sw-btn-small"
              onClick={() => void cancelWorkAction(item.id, card.cancelId!)}
            >
              Cancel
            </button>
          )}
          {card.viewInTerminal && (
            <button type="button" className="sw-btn sw-btn-small" onClick={viewInTerminal}>View in terminal</button>
          )}
        </span>
      </div>
      {card.lines && card.lines.length > 0 && (
        <ul className="sw-activity-lines" aria-label="Attempts">
          {card.lines.map(line => <li key={line}>{line}</li>)}
        </ul>
      )}
      {card.steps.length > 0 && (
        <ol className="sw-steps" aria-label="Ship it steps">
          {card.steps.map(step => (
            <li key={step.label} className="sw-step" data-state={step.state}>
              <span className={'sw-step-dot is-' + step.state} aria-hidden="true">{GLYPHS[step.state]}</span>
              {step.label}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
