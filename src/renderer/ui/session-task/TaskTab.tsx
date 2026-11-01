/**
 * The Task tab on Session work (#250): the BlaakTasks task the session works
 * on. Its title and status, Mark done, Snooze and Open in Notion; its PRs,
 * each in the state the session already knows it in; the brief; and the
 * progress log, oldest first, with the lines Switchboard wrote in the accent.
 *
 * Asked again each time the tab comes on screen, so it is as fresh as a look
 * at the web app. While BlaakTasks can't be reached the last answer stays.
 */
import { useEffect } from 'react';
import type { JSX } from 'react';
import { shallowEqual } from '../../state/store';
import { chipDot } from '../../state/ci-status-slice';
import {
  sessionTaskOf, taskName, taskPullRequestPills, writtenBySwitchboard,
} from '../../state/session-task-slice';
import type { SessionWorkPage } from '../../state/session-work-slice';
import type { PullRequestStatus } from '../../../domain/session-work/model';
import type { TaskDetail } from '../../../domain/tasks/model';
import { useStore } from '../use-store';
import { loadTask, markTaskDone, openTaskInNotion, openTaskPullRequest, snoozeTask } from './actions';
import { TaskStatusPill } from './TaskStatusPill';

const NO_PRS: readonly PullRequestStatus[] = [];

export function TaskTab({ page }: { page: SessionWorkPage }): JSX.Element {
  const { sessionId } = page;
  const linked = useStore(state => sessionTaskOf(state.sessionTask, sessionId), shallowEqual);
  const taskId = linked?.taskId ?? null;

  useEffect(() => {
    if (taskId) loadTask(taskId, { fresh: true });
  }, [taskId]);

  if (!linked) {
    return <div className="sw-empty">This session isn’t linked to a task.</div>;
  }
  const { load, detail } = linked;
  if (!detail) {
    return (
      <div className="st-tab" data-testid="session-task-tab">
        <div className={'st-note' + (load?.phase === 'failed' ? ' is-error' : '')} role="status">
          {load?.phase === 'failed' ? load.reason + ' · retrying when you look again' : 'Loading the task…'}
        </div>
      </div>
    );
  }
  return (
    <div className="st-tab" data-testid="session-task-tab">
      <div className="st-tab-inner">
        {load?.phase === 'failed' && <div className="st-note is-error" role="status">{load.reason} · showing what it said last</div>}
        <TaskHead detail={detail} />
        <TaskActions detail={detail} />
        <TaskPullRequests detail={detail} page={page} />
        <section className="st-section" aria-label="Brief">
          <h3 className="st-section-label">Brief</h3>
          {detail.brief.trim()
            ? <p className="st-brief">{detail.brief.trim()}</p>
            : <p className="st-faint">No brief.</p>}
        </section>
        <section className="st-section" aria-label="Progress">
          <h3 className="st-section-label">Progress</h3>
          {detail.progress.length === 0
            ? <p className="st-faint">Nothing logged yet.</p>
            : (
              <ol className="st-log">
                {detail.progress.map((entry, i) => (
                  <li key={i} className={writtenBySwitchboard(entry.text) ? 'is-switchboard' : undefined}
                    title={writtenBySwitchboard(entry.text) ? 'Written by Switchboard' : undefined}>
                    <span className="st-log-day">{dayLabel(entry.day)}</span>
                    <span className="st-log-text">{entry.text}</span>
                  </li>
                ))}
              </ol>
            )}
        </section>
      </div>
    </div>
  );
}

function TaskHead({ detail }: { detail: TaskDetail }): JSX.Element {
  const meta = [detail.client, detail.bucket, detail.dueLabel ? 'due ' + detail.dueLabel : null, detail.today ? '★ Today' : null]
    .filter((part): part is string => !!part);
  return (
    <div className="st-head">
      <div className="st-head-title">
        <h2 className="st-title">{taskName(detail)}</h2>
        <TaskStatusPill status={detail.status} />
      </div>
      {taskName(detail) !== detail.title && <p className="st-fulltitle">{detail.title}</p>}
      {meta.length > 0 && <p className="st-meta">{meta.join(' · ')}</p>}
    </div>
  );
}

function TaskActions({ detail }: { detail: TaskDetail }): JSX.Element {
  const { pending, error } = useStore(state => ({
    pending: state.sessionTask.pending?.taskId === detail.id ? state.sessionTask.pending.action : null,
    error: state.sessionTask.actionError?.taskId === detail.id ? state.sessionTask.actionError.message : null,
  }), shallowEqual);
  const done = detail.status === 'Done';
  return (
    <div className="st-actions">
      <button type="button" className="sw-btn" aria-disabled={done || pending !== null} disabled={done}
        onClick={() => { if (!pending) void markTaskDone(detail.id); }}>
        {pending === 'done' ? 'Marking done…' : done ? 'Done' : 'Mark done'}
      </button>
      <button type="button" className="sw-btn" aria-disabled={pending !== null} title="Snooze until tomorrow"
        onClick={() => { if (!pending) void snoozeTask(detail.id); }}>
        {pending === 'snooze' ? 'Snoozing…' : detail.snoozedUntil ? 'Snoozed' : 'Snooze'}
      </button>
      <button type="button" className="sw-btn" onClick={() => openTaskInNotion(detail.url)} disabled={!detail.url}>
        Open in Notion
      </button>
      {error && <span className="st-error" role="alert">{error}</span>}
    </div>
  );
}

function TaskPullRequests({ detail, page }: { detail: TaskDetail; page: SessionWorkPage }): JSX.Element | null {
  const dots = useStore(state => state.ciStatus.bySession[page.sessionId]);
  const known = page.snapshot
    ? page.snapshot.items.flatMap(item => (item.kind === 'pr' ? [item.pr] : []))
    : NO_PRS;
  if (detail.pullRequests.length === 0) return null;
  const pills = taskPullRequestPills(detail.pullRequests, known, number => chipDot(dots, number));
  return (
    <section className="st-section" aria-label="Pull requests">
      <h3 className="st-section-label">Pull requests</h3>
      <div className="st-prs">
        {pills.map(pill => (
          <button key={pill.url} type="button" className={'st-pr is-' + pill.tone}
            title={pill.url + (pill.state ? ' · ' + pill.state : '')}
            onClick={() => openTaskPullRequest(pill.url)}>
            {pill.label}
          </button>
        ))}
      </div>
    </section>
  );
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-10-28` as `28 Oct`. */
function dayLabel(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!match) return day;
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1] ?? match[2]}`;
}
