/**
 * Start level above the diagram (A1): the confirmation that names the count,
 * the session on its way, and the report of how many agents it started with
 * and which issues failed. Shown for the plan it was asked on.
 */
import type { JSX } from 'react';
import { sameIssue } from '../../../../domain/plan/model';
import type { Plan } from '../../../../domain/plan/model';
import { shortRef } from './describe';
import { levelStartLine } from './start-level';
import type { IssueActions } from './types';

export function LevelStart({ plan, issueActions }: { plan: Plan; issueActions?: IssueActions }): JSX.Element | null {
  const asked = issueActions?.levelStart;
  if (!asked || !sameIssue(asked.plan, plan)) return null;
  const count = asked.issues.length;
  const agents = count === 1 ? '1 agent' : `${count} agents`;

  if (asked.phase === 'confirm') {
    return (
      <div className="pv-confirm pv-level-start" role="group" aria-label="Start level">
        <strong>{`Start a session with ${agents}?`}</strong>
        <span>
          {`One session for level ${asked.level}, with a worktree and an agent for each Ready issue: `
            + asked.issues.map(issue => shortRef(plan, issue)).join(', ') + '. The session coordinates them.'}
        </span>
        <div className="pv-confirm-buttons">
          <button type="button" className="sw-btn is-primary" onClick={() => issueActions!.confirmLevelStart?.(plan)}>
            Start session
          </button>
          <button type="button" className="sw-btn" onClick={() => issueActions!.cancelLevelStart?.()}>Cancel</button>
        </div>
      </div>
    );
  }

  if (asked.phase !== 'answered') {
    return <div className="pv-inline pv-level-start" role="status">{`Starting a session with ${agents}…`}</div>;
  }

  return (
    <div className={'pv-inline pv-level-start' + (asked.failed.length ? ' is-error' : '')} role={asked.failed.length ? 'alert' : 'status'}>
      <span>{levelStartLine(asked)}</span>
      {asked.failed.length > 0 && (
        <ul className="pv-level-failed">
          {asked.failed.map(({ issue, reason }) => (
            <li key={issue.repository + '#' + issue.number}>{shortRef(plan, issue) + ': ' + reason}</li>
          ))}
        </ul>
      )}
      <button type="button" className="pv-pill" onClick={() => issueActions!.cancelLevelStart?.()}>Dismiss</button>
    </div>
  );
}
