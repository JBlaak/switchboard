/**
 * One session's row.
 *
 * Its place in the list, its label and its meta line come from the layout —
 * what the list showed at the last redraw — while everything that changes in
 * between is read live from the store: running, busy, ready, waiting, asking,
 * the agents, the highlight, the cursor and the exit. That split is what the
 * vanilla list got by patching classes in place; here it is simply what each
 * row subscribes to.
 */
import { useRef } from 'react';
import { askingCountIn } from '../../state/questions-slice';
import { rowActivity } from '../../state/row-activity';
import { sessionDisplayName } from '../../state/session-list-layout';
import { shallowEqual } from '../../state/store';
import { useStore } from '../use-store';
import { HTML } from './markup';
import { RenameInput } from './RenameInput';
import { RowMeta } from './RowMeta';
import {
  openRow, resumeWithConfig, startRename, stopRow, toggleArchive, togglePin,
} from './actions';
import { isLeaving } from './leave';
import type { JSX, MouseEvent } from 'react';
import type { SessionListRow } from '../../state/session-list-layout';
import type { WorkingAgent } from '../../../domain/terminal/program-status-children';

export interface SessionItemProps {
  row: SessionListRow;
  /** The slug group the row sits in, whose exit it shares. */
  groupId?: string;
}

interface LiveRow {
  running: boolean;
  active: boolean;
  needsAttention: boolean;
  responseReady: boolean;
  busy: boolean;
  agents: readonly WorkingAgent[];
  asking: number;
  cursor: boolean;
  leaving: boolean;
  renaming: boolean;
  now: number;
}

function useLiveRow(rowId: string, sessionId: string): LiveRow {
  return useStore((s): LiveRow => {
    const activity = rowActivity(s, sessionId);
    return {
      running: s.view.activePtyIds.has(sessionId),
      active: s.view.activeSessionId === sessionId,
      needsAttention: activity.needsAttention,
      responseReady: activity.responseReady,
      busy: activity.busy,
      agents: activity.agents,
      asking: askingCountIn(s.questions, sessionId),
      cursor: s.sessionList.cursor === rowId,
      leaving: !!s.sessionList.leaving[rowId],
      renaming: s.sessionList.renaming === rowId,
      now: s.sessionList.now,
    };
  }, shallowEqual);
}

/** The class list, in the order the vanilla row added them. */
function rowClass(row: SessionListRow, live: LiveRow): string {
  const { session } = row;
  const classes = ['session-item'];
  if (session.type === 'terminal') classes.push('is-terminal');
  if (session.archived) classes.push('archived-item');
  if (live.running) classes.push('has-running-pty');
  if (live.needsAttention) classes.push('needs-attention');
  if (live.responseReady) classes.push('response-ready');
  if (live.busy) classes.push('cli-busy');
  if (live.active) classes.push('active');
  if (live.cursor) classes.push('kbd-cursor');
  return classes.join(' ');
}

export function SessionItem({ row, groupId }: SessionItemProps): JSX.Element {
  const { session } = row;
  const { sessionId } = session;
  const live = useLiveRow(row.id, sessionId);
  const item = useRef<HTMLDivElement>(null);

  /** A row action, which must not also open the session, and does nothing on a row already leaving. */
  const action = (handler: (button: HTMLElement) => void) => (e: MouseEvent<HTMLElement>): void => {
    e.stopPropagation();
    if (!isLeaving(row.id, groupId)) handler(e.currentTarget);
  };

  // A terminal — local or remote — gets a glyph rather than a word, because
  // its label is already "Terminal".
  const terminal = session.type === 'terminal' || (session.type === 'remote' && session.remoteKind === 'shell');

  return (
    <div
      ref={item}
      className={rowClass(row, live)}
      id={row.id}
      data-session-id={sessionId}
      data-leaving={live.leaving ? '' : undefined}
      onClick={() => openRow(row.id, sessionId, groupId)}
    >
      <div className="session-row">
        <span
          className={'session-pin' + (session.starred ? ' pinned' : '')}
          data-testid="session-pin"
          dangerouslySetInnerHTML={session.starred ? HTML.pinFilled : HTML.pinOutline}
          onClick={action(pin => void togglePin(sessionId, pin))}
        />
        <span className={'session-status-dot' + (live.running ? ' running' : '')} data-testid="session-status-dot" />
        <div className="session-info">
          {live.renaming
            ? <RenameInput rowId={row.id} session={session} />
            : (
              <div
                className="session-summary"
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  startRename(row.id);
                }}
              >
                {terminal && <span className="terminal-badge" data-testid="terminal-badge" dangerouslySetInnerHTML={HTML.terminal} />}
                {sessionDisplayName(session)}
              </div>
            )}
          <RowMeta row={row} asking={live.asking} agents={live.agents} now={live.now} />
        </div>
        <RowActions
          row={row}
          onStop={action(() => stopRow(sessionId))}
          onArchive={action(button => item.current && toggleArchive(item.current, row.id, sessionId, button))}
          onResume={action(() => resumeWithConfig(sessionId))}
        />
      </div>
    </div>
  );
}

interface RowActionsProps {
  row: SessionListRow;
  onStop: (e: MouseEvent<HTMLElement>) => void;
  onArchive: (e: MouseEvent<HTMLElement>) => void;
  onResume: (e: MouseEvent<HTMLElement>) => void;
}

/**
 * The row's action buttons.
 *
 * Which ones appear depends on what the session actually supports. A remote
 * session has no local transcript to relaunch from; archive still works — it
 * is keyed on the session id alone — and doubles as "forget this one". A
 * plain terminal has nothing to archive or resume either. Stop is always
 * there; the stylesheet shows it only while something runs.
 */
function RowActions({ row, onStop, onArchive, onResume }: RowActionsProps): JSX.Element {
  const { session } = row;
  const archive = (
    <button
      className="session-archive-btn"
      title={session.archived ? 'Unarchive' : 'Archive'}
      dangerouslySetInnerHTML={HTML.archive16}
      onClick={onArchive}
    />
  );
  return (
    <div className="session-actions">
      <button
        className="session-stop-btn"
        title={session.type === 'remote' ? 'Disconnect (keeps running on the remote)' : 'Stop session'}
        dangerouslySetInnerHTML={HTML.stop}
        onClick={onStop}
      />
      {session.type === 'remote' && archive}
      {session.type !== 'remote' && session.type !== 'terminal' && (
        <>
          {archive}
          <button
            className="session-launch-config-btn"
            title="Resume with config"
            dangerouslySetInnerHTML={HTML.launchConfig}
            onClick={onResume}
          />
        </>
      )}
    </div>
  );
}
