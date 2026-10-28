/**
 * Link task… on Session work (#250): for a session that detection missed,
 * search the open tasks and pick one, or unlink the one it has.
 *
 * A button in the page's tab row while BlaakTasks is on; it opens a small
 * picker under itself. The field lists ★ Today until something is typed,
 * then the open tasks that match. ↑/↓ move, Enter links, Esc closes the
 * picker without closing the page.
 */
import { useEffect, useRef } from 'react';
import type { JSX, KeyboardEvent } from 'react';
import { shallowEqual } from '../../state/store';
import { sessionTaskOf, taskName } from '../../state/session-task-slice';
import { useStore } from '../use-store';
import { closeTaskPicker, linkTask, openTaskPicker, searchTasks, stepTaskPicker, unlinkTask } from './actions';
import { TaskStatusPill } from './TaskStatusPill';

/** How long typing rests before the search is sent. */
const SEARCH_DEBOUNCE_MS = 250;

export function LinkTaskButton({ sessionId }: { sessionId: string }): JSX.Element | null {
  const { enabled, open, linked } = useStore(state => ({
    enabled: state.tasks.enabled,
    open: state.sessionTask.picker?.sessionId === sessionId,
    linked: sessionTaskOf(state.sessionTask, sessionId) !== null,
  }), shallowEqual);
  if (!enabled) return null;
  return (
    <div className="st-link">
      <button
        type="button"
        className="st-link-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? closeTaskPicker() : openTaskPicker(sessionId))}
      >
        {linked ? 'Change task…' : 'Link task…'}
      </button>
      {open && <TaskPicker sessionId={sessionId} />}
    </div>
  );
}

function TaskPicker({ sessionId }: { sessionId: string }): JSX.Element | null {
  const picker = useStore(state => state.sessionTask.picker);
  const current = useStore(state => {
    const linked = sessionTaskOf(state.sessionTask, sessionId);
    return linked ? { taskId: linked.taskId, title: linked.detail ? taskName(linked.detail) : null } : null;
  }, shallowEqual);
  const field = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    field.current?.focus();
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, []);

  // A click anywhere else closes it.
  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      const target = e.target as Node;
      if (root.current && !root.current.parentElement?.contains(target)) closeTaskPicker();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, []);

  if (!picker) return null;

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    // The page's own keys (Esc, j/k, t) must not hear the picker's.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      closeTaskPicker();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      stepTaskPicker(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = picker.results[picker.cursor];
      if (row) void linkTask(sessionId, row.id);
    }
  };

  const status = picker.phase === 'failed'
    ? picker.error
    : picker.phase === 'searching' && picker.results.length === 0
      ? 'Searching…'
      : picker.results.length === 0
        ? (picker.query.trim() ? 'No open task matches.' : 'Nothing starred for today. Type to search.')
        : null;

  return (
    <div ref={root} className="st-picker" role="dialog" aria-label="Link task">
      <input
        ref={field}
        className="st-picker-field"
        type="search"
        placeholder="Search your tasks"
        aria-label="Search your tasks"
        defaultValue={picker.query}
        onKeyDown={onKeyDown}
        onChange={(e) => {
          const query = e.currentTarget.value;
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => void searchTasks(query), SEARCH_DEBOUNCE_MS);
        }}
      />
      {!picker.query.trim() && picker.results.length > 0 && <div className="st-picker-label">★ Today</div>}
      {status && <div className={'st-picker-status' + (picker.phase === 'failed' ? ' is-error' : '')}>{status}</div>}
      {picker.results.length > 0 && (
        <ul className="st-picker-list" role="listbox" aria-label="Tasks">
          {picker.results.map((row, i) => (
            <li key={row.id} role="option" aria-selected={i === picker.cursor}>
              <button
                type="button"
                className={'st-picker-row' + (i === picker.cursor ? ' is-cursor' : '') + (row.id === current?.taskId ? ' is-linked' : '')}
                onClick={() => void linkTask(sessionId, row.id)}
              >
                <span className="st-picker-title">{taskName(row)}</span>
                <TaskStatusPill status={row.status} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {current && (
        <button type="button" className="st-picker-unlink" onClick={() => void unlinkTask(sessionId)}>
          Unlink {current.title ? '“' + current.title + '”' : 'its task'}
        </button>
      )}
    </div>
  );
}
