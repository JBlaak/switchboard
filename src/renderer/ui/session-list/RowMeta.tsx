/**
 * A row's compact meta line: what it is asking, the project, the time and
 * message count, the agents badge and the PR chips on the left; the session's
 * first id segment on the right.
 */
import { pullRequestChips, pullRequestLabel } from '../../../domain/session/pull-requests';
import { projectLabel } from '../../features/sessions/project-label';
import { sessionTimeLabel } from '../../state/session-list-layout';
import { agentsBadgeHtml } from './markup';
import { openPullRequest, openRepository } from './actions';
import type { JSX } from 'react';
import type { SessionListRow } from '../../state/session-list-layout';
import type { WorkingAgent } from '../../../domain/terminal/program-status-children';

export interface RowMetaProps {
  row: SessionListRow;
  asking: number;
  agents: readonly WorkingAgent[];
  now: number;
}

export function RowMeta({ row, asking, agents, now }: RowMetaProps): JSX.Element {
  const { session } = row;
  const path = row.projectPath || session.projectPath;
  return (
    <div className="session-meta">
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
    </div>
  );
}

/**
 * The project the row belongs to, which opens its repository in the browser.
 *
 * Remote (`ssh://`) projects are not a link: their git lives on another host,
 * so a click on one falls through to the row.
 */
function ProjectLabel({ path }: { path: string | null | undefined }): JSX.Element | null {
  const label = projectLabel(path);
  if (!path || !label) return null;
  if (path.startsWith('ssh://')) return <span className="session-project is-remote" title={path}>{label}</span>;
  return <RepoLink path={path}>{label}</RepoLink>;
}

/** A project label that opens the repository, instead of the row or group it sits in. */
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
 * meta line is already the busiest part of the row.
 */
function PullRequests({ row }: { row: SessionListRow }): JSX.Element | null {
  const { shown, hidden } = pullRequestChips(row.session.pullRequests);
  if (!shown.length) return null;
  return (
    <span className="session-prs">
      {shown.map(pr => (
        <span
          key={pr.url + '#' + pr.number}
          className="session-pr"
          data-url={pr.url}
          title={pullRequestLabel(pr) + '\nClick to open the pull request in your browser'}
          onClick={(e) => {
            e.stopPropagation();
            if (pr.url) openPullRequest(pr.url);
          }}
        >
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
