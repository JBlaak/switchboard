/**
 * The Session work page's Plan tab (W1): the plan view for the session's plans,
 * as the plan slice last heard them from main. `install-plan` opens the view
 * and keeps it fresh; this only shows what there is.
 */
import type { JSX } from 'react';
import { useStore } from '../../use-store';
import { PlanView } from './PlanView';
import { useIssueActions } from './issue-actions';
import { sessionMap } from '../../../state/session-store';

/** `sessionId`: the page's session; new issue sessions start in its project. */
export function PlanTab({ sessionId }: { sessionId: string }): JSX.Element {
  const view = useStore(state => state.plan.view);
  const issueActions = useIssueActions(sessionMap.get(sessionId)?.projectPath ?? null);
  if (!view || !view.answer) {
    const failed = view?.phase === 'failed';
    return (
      <div className="pv pv-status" role="status">
        {failed ? 'Couldn’t ask GitHub for this session’s plans. Trying again in a minute.' : 'Loading the plan…'}
      </div>
    );
  }
  return <PlanView sessionPlans={view.answer} issueActions={issueActions} />;
}
