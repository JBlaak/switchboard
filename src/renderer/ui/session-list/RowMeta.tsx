/**
 * A row's compact meta line: what it is asking, the project, the time and
 * message count, the agents badge and the PR chips on the left; the session's
 * first id segment on the right.
 *
 * The whole line is one button that opens the session's Session work page
 * (D2), unless the page cannot open for it — a remote session, or one outside
 * a git repository (D14) — when it is plain text whose tooltip says why. The
 * project label and the PR chips inside it are display only.
 */
import { useEffect } from 'react';
import { pullRequestChips, pullRequestLabel } from '../../../domain/session/pull-requests';
import { projectLabel } from '../../features/sessions/project-label';
import { sessionDisplayName, sessionTimeLabel } from '../../state/session-list-layout';
import { useStore } from '../use-store';
import { canOpenSessionWork } from '../session-work/actions';
import { agentsBadgeHtml } from './markup';
import { openRepository } from './actions';
import type { JSX, MouseEvent } from 'react';
import type { SessionListRow } from '../../state/session-list-layout';
import type { WorkingAgent } from '../../../domain/terminal/program-status-children';

export interface RowMetaProps {
  row: SessionListRow;
  asking: number;
  agents: readonly WorkingAgent[];
  now: number;
  /** A click on the line when it is the Session work button. */
  onOpenWork: (e: MouseEvent<HTMLElement>) => void;
}

const REMOTE_REASON = "Session work isn't available for remote sessions yet";
const NO_REPO_REASON = 'Not a git repository';

export function RowMeta({ row, asking, agents, now, onOpenWork }: RowMetaProps): JSX.Element {
  const { session } = row;
  const path = row.projectPath || session.projectPath;
  const remote = session.type === 'remote' || !!path?.startsWith('ssh://');
  const canOpen = useCanOpenWork(session.sessionId, remote);

  const content = (
    <>
      <span className="session-meta-left">
        {/* What the session is blocked on, ahead of everything else on the line. */}
        {asking > 0 && (
          <span className="session-asking">
            {asking === 1 ? 'Asking 1 question' : `Asking ${asking} questions`}
          </span>
        )}
        <ProjectLabel path={path} />
        <span className="session-time">{sessionTimeLabel(session, now)}</span>
        {agents.length > 0 && <AgentsBadge agents={agents} />}
        <PullRequests row={row} />
      </span>
      <span className="session-short-id" title={session.sessionId}>{session.sessionId.split('-')[0]}</span>
    </>
  );

  if (canOpen === true) {
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
  const reason = remote ? REMOTE_REASON : canOpen === false ? NO_REPO_REASON : undefined;
  return <div className="session-meta" title={reason}>{content}</div>;
}

/**
 * Whether the page can open for this row's session: false at once for a
 * remote one, otherwise main's answer, asked once and kept in the store;
 * undefined while it is being asked.
 */
function useCanOpenWork(sessionId: string, remote: boolean): boolean | undefined {
  const known = useStore(state => (remote ? false : state.sessionWork.canOpen[sessionId]));
  useEffect(() => {
    if (!remote && known === undefined) void canOpenSessionWork(sessionId);
  }, [sessionId, remote, known]);
  return known;
}

/**
 * The project the row belongs to. Display only: a click on it is a click on
 * the line (which opens Session work) or, where the line is text, on the row.
 */
function ProjectLabel({ path }: { path: string | null | undefined }): JSX.Element | null {
  const label = projectLabel(path);
  if (!path || !label) return null;
  if (path.startsWith('ssh://')) return <span className="session-project is-remote" title={path}>{label}</span>;
  return <span className="session-project" title={path}>{label}</span>;
}

/**
 * A project label that opens the repository, instead of the group it sits in.
 * Only the slug group header still has one; a row's label is part of its
 * Session work button.
 */
export function RepoLink({ path, children }: { path: string; children: string }): JSX.Element {
  return (
    <span
      className="session-project is-repo-link"
      data-project-path={path}
      title={path + '\nClick to open the repository in your browser'}
      onClick={(e) => {
        e.stopPropagation();
        openRepository(path);
      }}
    >
      {children}
    </span>
  );
}

/**
 * The badge counting a session's working agents, right after the time so it
 * reads as one more piece of the row's metadata. The tooltip names each
 * agent's task.
 */
function AgentsBadge({ agents }: { agents: readonly WorkingAgent[] }): JSX.Element {
  const title = `${agents.length} ${agents.length === 1 ? 'agent' : 'agents'} working\n`
    + agents.map(agent => '• ' + (agent.title || 'Untitled agent')).join('\n');
  return <span className="session-agents" title={title} dangerouslySetInnerHTML={agentsBadgeHtml(agents.length)} />;
}

/**
 * The PRs the session opened, as `#1309` chips, newest first.
 *
 * Two at most, with the rest folded into a `+N` whose tooltip names them: the
 * meta line is already the busiest part of the row. Display only: the PRs are
 * on the Session work page, which the line opens.
 */
function PullRequests({ row }: { row: SessionListRow }): JSX.Element | null {
  const { shown, hidden } = pullRequestChips(row.session.pullRequests);
  if (!shown.length) return null;
  return (
    <span className="session-prs">
      {shown.map(pr => (
        <span key={pr.url + '#' + pr.number} className="session-pr" data-url={pr.url} title={pullRequestLabel(pr)}>
          {'#' + pr.number}
        </span>
      ))}
      {hidden.length > 0 && (
        <span className="session-pr-more" title={hidden.map(pullRequestLabel).join('\n')}>
          {'+' + hidden.length}
        </span>
      )}
    </span>
  );
}
