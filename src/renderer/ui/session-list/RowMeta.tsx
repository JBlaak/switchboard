/**
 * A row's compact meta line: what it is asking, the project, the time and
 * message count, the agents badge and the PR chips.
 *
 * The whole line is one button that opens the session's Session work page
 * (D2), unless the page cannot open for it — a remote session, or one outside
 * a git repository (D14) — when it is plain text whose tooltip says why. The
 * project label inside it keeps its own click, which opens the project page
 * (#173); the PR chips are display only.
 */
import { useEffect } from 'react';
import { pullRequestChips, pullRequestLabel } from '../../../domain/session/pull-requests';
import { projectLabel } from '../../features/sessions/project-label';
import { agentsTitle, askingLabel, sessionDisplayName, sessionTimeLabel } from '../../state/session-list-layout';
import { useStore } from '../use-store';
import { canOpenSessionWork } from '../session-work/actions';
import { isRemoteRow, workTrigger } from './work-trigger';
import { agentsBadgeHtml, HTML } from './markup';
import { ProjectLink } from '../project-page/ProjectLink';
import type { JSX, MouseEvent } from 'react';
import type { SessionListRow } from '../../state/session-list-layout';
import type { WorkingAgent } from '../../../domain/terminal/program-status-children';
import type { SessionPullRequest } from '../../../domain/session/session';
import { statusDotLabel, type StatusDot } from '../../../domain/session-work/status';
import { chipDot, hiddenChipsDot } from '../../state/ci-status-slice';

export interface RowMetaProps {
  row: SessionListRow;
  asking: number;
  agents: readonly WorkingAgent[];
  now: number;
  /** A click on the line when it is the Session work button. */
  onOpenWork: (e: MouseEvent<HTMLElement>) => void;
}

export function RowMeta({ row, asking, agents, now, onOpenWork }: RowMetaProps): JSX.Element {
  const { session } = row;
  const path = row.projectPath || session.projectPath;
  const remote = isRemoteRow(session, path);
  const trigger = workTrigger(remote, useCanOpenWork(session.sessionId, remote));

  const content = (
    <span className="session-meta-left">
      {/* What the session is blocked on, ahead of everything else on the line. */}
      {asking > 0 && (
        <span className="session-asking">{askingLabel(asking)}</span>
      )}
      <ProjectLabel path={path} />
      <span className="session-time">{sessionTimeLabel(session, now)}</span>
      {agents.length > 0 && <AgentsBadge agents={agents} />}
      <PullRequests row={row} />
    </span>
  );

  if (trigger.button) {
    return (
      <button
        type="button"
        className="session-meta is-work-trigger"
        title="Open session work · ⌘G"
        aria-label={'Open session work for ' + sessionDisplayName(session)}
        onClick={onOpenWork}
      >
        {content}
      </button>
    );
  }
  return <div className="session-meta" title={trigger.reason}>{content}</div>;
}

/**
 * Whether the page can open for this row's session: false at once for a
 * remote one, otherwise main's answer, asked once and kept in the store;
 * undefined while it is being asked.
 */
export function useCanOpenWork(sessionId: string, remote: boolean): boolean | undefined {
  const known = useStore(state => (remote ? false : state.sessionWork.canOpen[sessionId]));
  useEffect(() => {
    if (!remote && known === undefined) void canOpenSessionWork(sessionId);
  }, [sessionId, remote, known]);
  return known;
}

/**
 * The project the row belongs to, as a way into its page: a click on it opens
 * the project page rather than whatever the line or the row would, and
 * ⌘-click opens GitHub.
 */
function ProjectLabel({ path }: { path: string | null | undefined }): JSX.Element | null {
  const label = projectLabel(path);
  if (!path || !label) return null;
  return (
    <ProjectLink path={path} className={'session-project' + (path.startsWith('ssh://') ? ' is-remote' : '')}>
      {label}
    </ProjectLink>
  );
}

/**
 * The badge counting a session's working agents, right after the time so it
 * reads as one more piece of the row's metadata. The tooltip names each
 * agent's task.
 */
function AgentsBadge({ agents }: { agents: readonly WorkingAgent[] }): JSX.Element {
  return <span className="session-agents" title={agentsTitle(agents)} dangerouslySetInnerHTML={agentsBadgeHtml(agents.length)} />;
}

/**
 * The PRs the session opened, as `#1309` chips, newest first.
 *
 * Two at most, with the rest folded into a `+N` whose tooltip names them: the
 * meta line is already the busiest part of the row. Display only: the PRs are
 * on the Session work page, which the line opens.
 */
function PullRequests({ row }: { row: SessionListRow }): JSX.Element | null {
  const status = useStore(state => state.ciStatus.bySession[row.session.sessionId]);
  const { shown, hidden } = pullRequestChips(row.session.pullRequests);
  if (!shown.length) return null;
  // Each chip says how its PR is doing once the CI watch has (W4); the `+N`
  // takes the worst of the ones it hides, and its tooltip names each one's.
  const label = (pr: SessionPullRequest): string => {
    const dot = chipDot(status, pr.number);
    return pullRequestLabel(pr) + (dot ? ' · ' + statusDotLabel(dot) : '');
  };
  const hiddenDot = hiddenChipsDot(status, hidden.map(pr => pr.number));
  return (
    <span className="session-prs">
      {shown.map(pr => (
        <span key={pr.url + '#' + pr.number} className="session-pr" data-url={pr.url} title={label(pr)}>
          <ChipDot dot={chipDot(status, pr.number)} />
          {'#' + pr.number}
        </span>
      ))}
      {hidden.length > 0 && (
        <span className="session-pr-more" title={hidden.map(label).join('\n')}>
          <ChipDot dot={hiddenDot} />
          {'+' + hidden.length}
        </span>
      )}
    </span>
  );
}

/**
 * A chip's status dot, or a check once its PR is merged; nothing until the CI
 * watch has said something about it.
 */
function ChipDot({ dot }: { dot: StatusDot | null }): JSX.Element | null {
  if (!dot) return null;
  if (dot === 'merged') {
    return <span className="session-pr-merged" data-dot={dot} aria-hidden="true" dangerouslySetInnerHTML={HTML.mergedCheck} />;
  }
  return <span className={'session-pr-dot is-' + dot} data-dot={dot} aria-hidden="true" />;
}
