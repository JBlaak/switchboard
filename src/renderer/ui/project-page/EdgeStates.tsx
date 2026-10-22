/**
 * What the project page shows in place of its GitHub sections when it has
 * nothing to show in them (#175, artboard 5): the one message when `gh` is
 * missing, signed out or GitHub unreachable, the line over stale data, and the
 * note on a remote project. Which state the page is in is `page-state`.
 */
import type { JSX } from 'react';
import { useStore } from '../use-store';
import type { GitHubUnavailableReason } from '../../../domain/project/overview';
import { staleLine, unavailableMessage } from './page-state';
import { copyAuthCommand, reloadProjectOverview } from './actions';

/** One message in place of Plans & issues and Pull requests, with Try again (and Copy command). */
export function GitHubMessage({ reason }: { reason: GitHubUnavailableReason }): JSX.Element {
  const message = unavailableMessage(reason);
  return (
    <section className="pp-card pp-message" role="status" aria-label="GitHub">
      <div className="pp-message-title">{message.title}</div>
      <div className="pp-message-text">
        {message.before}
        {message.command && <code className="pp-code">{message.command}</code>}
        {message.after}
      </div>
      <div className="pp-message-actions">
        <button type="button" className="sw-btn" onClick={reloadProjectOverview}>Try again</button>
        {message.command && <button type="button" className="sw-btn" onClick={copyAuthCommand}>Copy command</button>}
      </div>
    </section>
  );
}

/** Over stale data: GitHub could not be reached, and how old what is shown is. */
export function StaleLine({ fetchedAt }: { fetchedAt: number }): JSX.Element {
  const now = useStore(state => state.sessionList.now) || Date.now();
  return (
    <div className="pp-stale" role="status">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
        <path d="M12 8v5M12 16.5v.5" />
        <circle cx="12" cy="12" r="9" />
      </svg>
      {staleLine(fetchedAt, Math.max(now, fetchedAt))}
    </div>
  );
}

/** Under a remote project's sessions: what the page does not read there. */
export function RemoteNote(): JSX.Element {
  return <div className="pp-remote-note">Plans and worktrees aren’t read over ssh.</div>;
}
