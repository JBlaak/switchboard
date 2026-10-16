/**
 * The card that narrates a remote session's connection.
 *
 * A remote terminal is empty until ssh says something, and ssh can take a long
 * time to say anything — a sleeping host, a 1Password approval, a banner
 * exchange that never completes. Without a status of its own the screen is
 * indistinguishable from a frozen app, which is exactly what a slow or failing
 * connect looked like.
 *
 * It lives inside the terminal's slot, so it follows the terminal into a grid
 * card with no extra plumbing, and draws itself from the store: the status
 * main last sent, the card's own beat and bar (`remote-slice`), and the shared
 * tick for its countdown. The scrollback lines that go with each break are
 * written elsewhere (`connection-log`). Local sessions never have a status, so
 * they never render one.
 */
import type { CSSProperties, JSX } from 'react';
import { isConnectionInFlight } from '../../../domain/remote/remote-status';
import { remoteCardShownIn } from '../../state/remote-slice';
import { shallowEqual } from '../../state/store';
import { useStore } from '../use-store';
import { retryRemote, stopTrying } from './actions';
import { remoteCardCopy } from './card-copy';

export interface RemoteCardProps {
  sessionId: string;
}

export function RemoteCard({ sessionId }: RemoteCardProps): JSX.Element | null {
  const { shown, status, card } = useStore(state => {
    const status = state.remote.statuses[sessionId];
    return {
      shown: remoteCardShownIn(state.remote, sessionId),
      status,
      card: state.remote.cards[sessionId],
      // Selected only so each tick re-renders a countdown that is running.
      tickAt: isConnectionInFlight(status) ? state.remote.tickAt : 0,
    };
  }, shallowEqual);

  if (!shown || !status || !card) return null;
  const copy = remoteCardCopy(status, Date.now());
  const barStyle = card.barMs === undefined
    ? undefined
    : { '--rc-duration': card.barMs + 'ms' } as CSSProperties;

  return (
    <div className={'rc is-' + status.phase}>
      <div className="rc-card">
        <svg className="rc-link" viewBox="0 0 220 58" aria-hidden="true">
          <rect className="rc-node" x="11" y="18" width="38" height="26" rx="5" />
          <circle className="rc-node-mark" cx="30" cy="31" r="4" />
          <path className="rc-wire" d="M55 31H165" />
          <path className="rc-flow" d="M55 31H165" />
          <circle className="rc-spark" cx="55" cy="31" r="3.5" />
          <g className="rc-break">
            <path d="M103 22l14 18" />
            <path d="M117 22l-14 18" />
          </g>
          <rect className="rc-node" x="171" y="18" width="38" height="26" rx="5" />
          <path className="rc-node-mark" d="M178 25h24M178 31h24M178 37h15" />
        </svg>
        <div className="rc-status">{copy.status}</div>
        <div className="rc-target">{status.target || 'the remote host'}</div>
        {/* A new run is a new fill element: re-assigning a class does not replay keyframes. */}
        <div className="rc-bar" data-testid="remote-progress" style={barStyle}><i key={card.barRun} /></div>
        <div className="rc-detail">{copy.detail}</div>
        <div className="rc-actions">
          <button className="rc-retry" type="button" onClick={() => void retryRemote(sessionId)}>Retry now</button>
          <button className="rc-cancel" type="button" onClick={() => stopTrying(sessionId)}>Stop trying</button>
        </div>
      </div>
    </div>
  );
}
