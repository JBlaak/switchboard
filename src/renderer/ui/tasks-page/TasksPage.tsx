/**
 * The Tasks page (#249): what the main area shows while its route is
 * `tasks`. BlaakTasks' views (★ Today, In progress, Due, Quick and a search)
 * for Work or Private, one row per task, and the open task's detail beside
 * them.
 *
 * Its keys, while it has the focus and never in an input: ↑/↓ (J/K) move the
 * cursor, and on the row under it S starts a session (asking for any extra
 * instructions first), * stars it for today, D marks it done, Z snoozes it to
 * tomorrow, O opens it in Notion and Enter opens its detail; / searches; Esc puts away what is open, then closes the
 * page. What each key does is `page-keys`.
 *
 * A click on a row opens its detail too.
 *
 * Rendered into `#tasks-page`, which `ui/main-area/install-main-area` shows
 * and hides with the route.
 */
import { useEffect, useLayoutEffect, useRef, type JSX, type KeyboardEvent } from 'react';
import { dispatch, getState } from '../../state/app-store';
import { useStore } from '../use-store';
import { formatDate } from '../../lib/format';
import {
  TASKS_TABS, cursorRow, listAnswered, visibleRows, type TasksState,
} from '../../state/tasks-slice';
import { ADD_TO_CLAUDE_LINE } from '../../../domain/tasks/model';
import { TaskRow } from '../tasks/TaskRow';
import { StartPanel } from './StartPanel';
import { TaskDetailPane } from './TaskDetailPane';
import { tasksKeyAction } from './page-keys';
import {
  askStartInstructions, closeProjectList, closeTaskDetail, closeTasksPage, dismissStart, markTaskDone, openTaskDetail,
  openTaskInNotion, snoozeTask, starTask,
} from './actions';

export function TasksPage(): JSX.Element | null {
  const open = useStore(state => state.mainArea.route.kind === 'tasks');
  return open ? <TasksView /> : null;
}

function TasksView(): JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const tasks = useStore(state => state.tasks);
  const rows = visibleRows(tasks);
  const under = cursorRow(tasks);
  const detailTask = tasks.detail ? rows.find(row => row.id === tasks.detail!.taskId) ?? null : null;

  // Into the page as it opens, so its keys reach it without a click.
  useLayoutEffect(() => {
    root.current?.focus({ preventScroll: true });
  }, []);

  // The search tab types straight away.
  useLayoutEffect(() => {
    if (tasks.tab === 'search') searchInput.current?.focus();
  }, [tasks.tab]);

  // The row under the cursor stays in view.
  useEffect(() => {
    if (!under) return;
    root.current?.querySelector(`[data-task-id="${CSS.escape(under.id)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [under?.id]);

  const backToRows = (): void => root.current?.focus({ preventScroll: true });

  // A control that had the keyboard went away with what it was in (the
  // project list, the detail, a start's answer): the rows have it again.
  useEffect(() => {
    const focused = document.activeElement;
    if (!focused || focused === document.body) backToRows();
  }, [tasks.picker, tasks.detail, tasks.start]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.target as HTMLElement).matches('input, textarea, select, [contenteditable="true"]')) return;
    const state = getState().tasks;
    if (e.key === 'Escape' && !e.shiftKey) {
      e.preventDefault();
      if (state.picker) closeProjectList();
      else if (state.start && state.start.phase !== 'starting') dismissStart();
      else if (state.detail) closeTaskDetail();
      else closeTasksPage();
      return;
    }
    // S and * are typed shifted as well; the rest are bare.
    if (e.shiftKey && e.key !== 'S' && e.key !== '*') return;
    const action = tasksKeyAction(e.key, visibleRows(state), state.cursor);
    if (!action) return;
    e.preventDefault();
    switch (action.kind) {
      case 'cursor': dispatch({ type: 'tasksCursorMoved', taskId: action.taskId }); break;
      case 'search':
        dispatch({ type: 'tasksTabChosen', tab: 'search' });
        searchInput.current?.focus();
        break;
      case 'start': askStartInstructions(action.task); break;
      case 'star': void starTask(action.task); break;
      case 'done': void markTaskDone(action.task); break;
      case 'snooze': void snoozeTask(action.task); break;
      case 'notion': void openTaskInNotion(action.task.id); break;
      case 'detail':
        if (state.detail?.taskId === action.task.id) closeTaskDetail();
        else void openTaskDetail(action.task.id);
        break;
    }
  };

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      backToRows();
    } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      dispatch({ type: 'tasksCursorMoved', taskId: visibleRows(getState().tasks)[0]?.id ?? null });
      backToRows();
    }
  };

  return (
    <div ref={root} className="sw-page tasks-page" tabIndex={-1} role="region" aria-label="Tasks" onKeyDown={onKeyDown}>
      <header className="sw-header pp-header">
        <div className="sw-header-row">
          <button type="button" className="sw-btn sw-back" onClick={closeTasksPage} aria-label="Close tasks (Esc)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
            Close <kbd className="sw-kbd">esc</kbd>
          </button>
          <div className="sw-heading">
            <h1 className="sw-title pp-title">Tasks</h1>
            <div className="sw-subline pp-subline">
              <span>BlaakTasks</span>
              <UpdatedAt fetchedAt={tasks.list?.fetchedAt ?? null} />
            </div>
          </div>
          <div className="tk-segmented" role="radiogroup" aria-label="Context">
            {(['work', 'private'] as const).map(context => (
              <button
                type="button"
                key={context}
                role="radio"
                aria-checked={tasks.context === context}
                className={'tk-segment' + (tasks.context === context ? ' is-on' : '')}
                onClick={() => dispatch({ type: 'tasksContextChosen', context })}
              >
                {context === 'work' ? 'Work' : 'Private'}
              </button>
            ))}
          </div>
        </div>
      </header>

      <nav className="tk-tabs" role="tablist" aria-label="Views">
        {TASKS_TABS.filter(({ tab }) => tab !== 'search').map(({ tab, label }) => (
          <button
            type="button"
            key={tab}
            role="tab"
            aria-selected={tasks.tab === tab}
            className={'tk-tab' + (tasks.tab === tab ? ' is-on' : '')}
            onClick={() => { dispatch({ type: 'tasksTabChosen', tab }); backToRows(); }}
          >
            {label}
          </button>
        ))}
        <label className={'tk-search' + (tasks.tab === 'search' ? ' is-on' : '')}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-4-4" />
          </svg>
          <input
            ref={searchInput}
            type="text"
            className="tk-search-input"
            placeholder="Search…"
            aria-label="Search tasks"
            value={tasks.search}
            spellCheck={false}
            onFocus={() => dispatch({ type: 'tasksTabChosen', tab: 'search' })}
            onChange={e => dispatch({ type: 'tasksSearchTyped', search: e.target.value })}
            onKeyDown={onSearchKeyDown}
          />
        </label>
      </nav>

      <StatusLine tasks={tasks} />

      <div className={'tk-body' + (detailTask ? ' has-detail' : '')}>
        <div className="tk-list-wrap">
          <div className="tk-list pp-card" role="listbox" aria-label="Tasks">
            <EmptyLine tasks={tasks} count={rows.length} />
            {rows.map(task => (
              <TaskRow
                key={task.id}
                task={task}
                repo={tasks.links.repos[task.id] ?? null}
                sessions={tasks.links.sessions[task.id] ?? 0}
                cursor={under?.id === task.id}
                starting={tasks.start?.taskId === task.id && tasks.start.phase === 'starting'}
                onClick={() => {
                  dispatch({ type: 'tasksCursorMoved', taskId: task.id });
                  backToRows();
                  if (getState().tasks.detail?.taskId !== task.id) void openTaskDetail(task.id);
                }}
              >
                {tasks.start?.taskId === task.id && <StartPanel task={task} start={tasks.start} />}
              </TaskRow>
            ))}
          </div>
        </div>
        {detailTask && <TaskDetailPane task={detailTask} />}
      </div>

      <footer className="tk-keys" aria-label="Keys">
        <span><kbd className="sw-kbd">S</kbd> start session</span>
        <span><kbd className="sw-kbd">*</kbd> ★ today</span>
        <span><kbd className="sw-kbd">D</kbd> done</span>
        <span><kbd className="sw-kbd">Z</kbd> snooze to tomorrow</span>
        <span><kbd className="sw-kbd">O</kbd> open in Notion</span>
        <span><kbd className="sw-kbd">↵</kbd> detail</span>
        <span><kbd className="sw-kbd">/</kbd> search</span>
      </footer>
    </div>
  );
}

/** "Updated 2m ago": when the list was last read. */
function UpdatedAt({ fetchedAt }: { fetchedAt: number | null }): JSX.Element | null {
  const now = useStore(state => state.sessionList.now) || Date.now();
  if (fetchedAt === null) return null;
  return <span className="pp-updated">Updated {formatDate(new Date(fetchedAt), Math.max(now, fetchedAt))}</span>;
}

/** An outage keeps the list, under one quiet line; a key's answer shows here too. */
function StatusLine({ tasks }: { tasks: TasksState }): JSX.Element | null {
  const list = listAnswered(tasks) ? tasks.list : null;
  if (list?.state === 'unreachable' || list?.state === 'failed') {
    return (
      <div className="tk-status is-outage" role="status" title={list.reason ?? undefined}>
        {list.state === 'unreachable' ? "Couldn't reach BlaakTasks · retrying" : "BlaakTasks didn't answer the list · retrying"}
      </div>
    );
  }
  if (list?.state === 'notSetUp') {
    return <div className="tk-status is-outage" role="status">{ADD_TO_CLAUDE_LINE}: see Settings.</div>;
  }
  if (tasks.notice) {
    return <div className={'tk-status' + (tasks.notice.tone === 'error' ? ' is-error' : '')} role="status">{tasks.notice.text}</div>;
  }
  return null;
}

function EmptyLine({ tasks, count }: { tasks: TasksState; count: number }): JSX.Element | null {
  if (count > 0) return null;
  if (tasks.tab === 'search' && !tasks.search.trim()) return <div className="pp-quiet">Type to search your open tasks.</div>;
  if (!listAnswered(tasks)) return <div className="pp-quiet">Loading…</div>;
  if (tasks.list?.state !== 'ok' && tasks.list?.rows.length === 0) return <div className="pp-quiet">Nothing to show yet.</div>;
  return <div className="pp-quiet">{tasks.tab === 'search' ? 'No open task matches.' : 'Nothing here.'}</div>;
}
