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
import { useCallback, useRef, useState } from 'react';
import { askingCountIn } from '../../state/questions-slice';
import { rowActivity } from '../../state/row-activity';
import { rowButtons, sessionDisplayName, showsTerminalBadge } from '../../state/session-list-layout';
import { shallowEqual } from '../../state/store';
import { useStore } from '../use-store';
import { HTML } from './markup';
import { RenameInput } from './RenameInput';
import { RowMeta, useCanOpenWork } from './RowMeta';
import {
  openRow, resumeWithConfig, snoozeRow, startRename, stopRow, toggleArchive, togglePin,
} from './actions';
import { isLeaving } from './leave';
import { SnoozeMenu, snoozeTime } from './SnoozeMenu';
import { openSessionWorkFromRow } from '../session-work/actions';
import { highlightedSession } from '../../state/main-area-slice';
import { TaskMarker } from '../session-task/TaskMarker';
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
      active: highlightedSession(s.mainArea) === sessionId,
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

  const openWork = action(() => void openSessionWorkFromRow(sessionId));

  const terminal = showsTerminalBadge(session);

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
                <TaskMarker sessionId={sessionId} />
                {sessionDisplayName(session)}
              </div>
            )}
          <RowMeta
            row={row}
            asking={live.asking}
            agents={live.agents}
            now={live.now}
            onOpenWork={openWork}
          />
        </div>
        <RowActions
          row={row}
          onOpenWork={openWork}
          onStop={action(() => stopRow(sessionId))}
          onArchive={action(button => item.current && toggleArchive(item.current, row.id, sessionId, button))}
          onSnooze={(moon, until) => {
            if (item.current && !isLeaving(row.id, groupId)) snoozeRow(item.current, row.id, sessionId, moon, until);
          }}
          onResume={action(() => resumeWithConfig(sessionId))}
        />
      </div>
    </div>
  );
}

interface RowActionsProps {
  row: SessionListRow;
  onOpenWork: (e: MouseEvent<HTMLElement>) => void;
  onStop: (e: MouseEvent<HTMLElement>) => void;
  onArchive: (e: MouseEvent<HTMLElement>) => void;
  /** A time from the snooze menu, or null for Wake; `moon` is the icon that nods off. */
  onSnooze: (moon: HTMLElement, until: Date | null) => void;
  onResume: (e: MouseEvent<HTMLElement>) => void;
}

/**
 * The row's action buttons, as `rowButtons` says the session supports them.
 * Session work appears only when its page can open, the same rule as the
 * meta line.
 */
function RowActions({ row, onOpenWork, onStop, onArchive, onSnooze, onResume }: RowActionsProps): JSX.Element {
  const { session } = row;
  const path = row.projectPath || session.projectPath;
  const remote = session.type === 'remote' || !!path?.startsWith('ssh://');
  const canOpenWork = useCanOpenWork(session.sessionId, remote);
  const buttons = rowButtons(session);
  const snooze = useRef<HTMLButtonElement>(null);
  const [snoozing, setSnoozing] = useState(false);
  const closeSnooze = useCallback(() => setSnoozing(false), []);
  const snoozedUntil = session.snoozedUntil && Date.parse(session.snoozedUntil) > Date.now() ? session.snoozedUntil : null;
  return (
    <div className={'session-actions' + (snoozing ? ' menu-open' : '')}>
      {canOpenWork === true && (
        <button
          className="session-work-btn"
          title="Open session work · ⌘G"
          dangerouslySetInnerHTML={HTML.sessionWork}
          onClick={onOpenWork}
        />
      )}
      <button
        className="session-stop-btn"
        title={buttons.stop}
        dangerouslySetInnerHTML={HTML.stop}
        onClick={onStop}
      />
      {buttons.archive && (
        <button
          className="session-archive-btn"
          title={buttons.archive}
          dangerouslySetInnerHTML={session.archived ? HTML.unarchive16 : HTML.archive16}
          onClick={onArchive}
        />
      )}
      {buttons.snooze && (
        <button
          ref={snooze}
          className={'session-snooze-btn' + (snoozedUntil ? ' snoozed' : '')}
          title={snoozedUntil ? `Snoozed until ${snoozeTime(new Date(snoozedUntil), new Date())}` : 'Snooze'}
          aria-haspopup="menu"
          aria-expanded={snoozing}
          onClick={(e) => {
            e.stopPropagation();
            setSnoozing(!snoozing);
          }}
        >
          <span className="snooze-moon" dangerouslySetInnerHTML={HTML.moon} />
        </button>
      )}
      {snoozing && snooze.current && (
        <SnoozeMenu
          anchor={snooze.current}
          snoozedUntil={snoozedUntil}
          onClose={closeSnooze}
          onPick={(until) => {
            setSnoozing(false);
            const moon = snooze.current?.querySelector<HTMLElement>('.snooze-moon');
            if (moon) onSnooze(moon, until);
          }}
        />
      )}
      {buttons.resume && (
        <button
          className="session-launch-config-btn"
          title="Resume with config"
          dangerouslySetInnerHTML={HTML.launchConfig}
          onClick={onResume}
        />
      )}
    </div>
  );
}
