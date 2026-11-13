/**
 * The project page's own state (#173): which of its plans are expanded,
 * whether closed ones show, where the keyboard cursor is and what the rows are
 * filtered by.
 *
 * It belongs to one project at a time, the one whose page last opened. The
 * expanded plans and Show closed are that project's memory, persisted per
 * project in localStorage (`ui/project-page/install-project-page` reads it
 * back as the page opens and writes it as it changes); the cursor and the
 * filter start empty every time the page opens.
 *
 * The project's overview (#172) is kept here too, as main last answered it
 * for the open project: `ui/project-page/install-project-page` asks for it as
 * the page opens and every minute while it stays on screen (#174). Which of
 * its rows are on screen is `ui/project-page/page-rows`. It is asked twice at
 * once, without plans and in full: the first to land shows, but an answer
 * without plans never takes the place of a full one (`overviewAnswered`).
 * As the page opens, the last full answer stored for it (`stored-overviews`)
 * shows until main's come, marked as being updated.
 *
 * So are the project's open BlaakTasks tasks (#251), the ones linked to it,
 * asked alongside the overview while BlaakTasks is on. A row key on the
 * Tasks page's actions (★, Done, snooze) changes them here too, through
 * `tasksRowChanged`; switching BlaakTasks off forgets them.
 *
 * What else the page shows is not here: the route says which project and
 * which of its views (`main-area-slice`), and the sessions come from the
 * cached projects.
 *
 * So is the merge queue's side of the page (#315): the errands Nudge and Fix
 * in session started in the repository, read again with each overview, and
 * how each of the queue's buttons is getting on (`queueActions`, by
 * `queueActionKey`). The queue itself is the overview's. The CI job queue
 * under it (`ciJobQueue`) is read on its own, only while the section shows.
 *
 * The events are declared here rather than in `events.ts`, like the session
 * list's, so the page's vocabulary stays in one file.
 */
import type {RendererEvent} from './events';
import type {RendererState} from './root';
import {projectRoute} from './main-area-slice';
import type {ProjectOverview, WorktreeCleanResult} from '../../domain/project/overview';
import type {IssueSessionStart} from '../../domain/plan/issue-session';
import type {TaskRow} from '../../domain/tasks/model';
import type {StoredOverview} from './stored-overviews';
import type {QueueErrandView} from '../../domain/project/queue-errands';
import type {CiJobQueueAnswer} from '../../domain/project/ci-job-queue';

export type ProjectPageEvent =
    /** The page opened on `projectPath`, with what it remembered of it. */
    | {
          type: 'projectPageRestored';
          projectPath: string;
          memory: ProjectPageMemory;
          /** Its last full overview from an earlier visit, asked as `memory` asks now; shown until main answers. */
          stored?: StoredOverview | null;
      }
    /** A plan (`owner/repo#n`) expanded or collapsed in place. */
    | {type: 'projectPlanToggled'; plan: string}
    /** A plan expanded (→), or collapsed (←); nothing when it already is. */
    | {type: 'projectPlanExpanded'; plan: string}
    | {type: 'projectPlanCollapsed'; plan: string}
    /**
     * Main answered the overview of `projectPath`, asked with closed plans and
     * merged PRs or without, and with its plans or (`plans` false) without.
     */
    | {
          type: 'projectOverviewAnswered';
          projectPath: string;
          closed: boolean;
          merged: boolean;
          plans: boolean;
          overview: ProjectOverview;
      }
    /** Show N more: every issue that is not in a plan, not only the first few. */
    | {type: 'projectLooseExpanded'}
    /** Start session on an issue (`owner/repo#n`) under the page, and how it went. */
    | {type: 'projectIssueStartAsked'; issue: string}
    | {type: 'projectIssueStartAnswered'; issue: string; result: IssueSessionStart}
    | {type: 'projectShowClosedToggled'}
    /** Show merged in the Pull requests section (#175). */
    | {type: 'projectShowMergedToggled'}
    /** Start session on one of the project's worktrees (#175), by its path, and how it went. */
    | {type: 'projectWorktreeStartAsked'; path: string}
    | {
          type: 'projectWorktreeStartAnswered';
          path: string;
          result: {ok: true; sessionId: string} | {ok: false; reason: string};
      }
    /** Clean: the project's superfluous worktrees being removed, and what main answered. */
    | {type: 'projectWorktreesCleanAsked'}
    | {type: 'projectWorktreesCleanAnswered'; projectPath: string; result: WorktreeCleanResult}
    /** The keyboard cursor moved to a row (null: it is gone). */
    | {type: 'projectCursorMoved'; target: string | null}
    /** The text the page's rows are filtered by (`/`). */
    | {type: 'projectFilterChanged'; filter: string}
    /** The open tasks linked to `projectPath` (#251), newest link first, and how many sessions worked on each. */
    | {
          type: 'projectTasksAnswered';
          projectPath: string;
          rows: readonly TaskRow[];
          sessions: Readonly<Record<string, number>>;
      }
    /** The merge queue's errands in `repository` (#315), as main last answered them. */
    | {type: 'projectQueueErrandsAnswered'; repository: string; errands: readonly QueueErrandView[]}
    /** One of the merge queue's buttons was pressed (#315), by `queueActionKey`; and how it went. */
    | {type: 'projectQueueActionAsked'; key: string}
    | {type: 'projectQueueActionAnswered'; key: string; outcome: QueueActionOutcome}
    /** The CI job queue of `repository`, as main last answered it. */
    | {type: 'projectCiJobQueueAnswered'; repository: string; answer: CiJobQueueAnswer};

/** How a merge queue button's job ended: done (nothing more to show), done with a note, or why not. */
export type QueueActionOutcome =
    | {readonly phase: 'done'}
    | {readonly phase: 'note'; readonly text: string}
    | {readonly phase: 'failed'; readonly reason: string};

/** A merge queue button's state: its job running, or how it ended (anything but plain done). */
export type QueueActionState = {readonly phase: 'busy'} | Exclude<QueueActionOutcome, {phase: 'done'}>;

/** The merge queue's errands (#315) for one repository. */
export interface ProjectQueueErrands {
    readonly repository: string;
    /** Oldest first, as main answers them. */
    readonly errands: readonly QueueErrandView[];
}

/** The CI job queue (its jobs by runner pool) of one repository. */
export interface ProjectCiJobQueue {
    readonly repository: string;
    readonly answer: CiJobQueueAnswer;
}

/**
 * Which button a `queueActions` entry is: one per job and PR (and reviewer,
 * for a nudge); a bump's is the bumped CI job's id.
 */
export function queueActionKey(
    job: 'nudge' | 'fix' | 'retry' | 'opt-in' | 'bump' | 'try-again',
    number: number,
    reviewer?: string,
): string {
    return job + ':' + number + (reviewer ? ':' + reviewer : '');
}

/** The project's open tasks (#251), as last read for it. */
export interface ProjectTasks {
    readonly projectPath: string;
    /** Not Done or Dropped, newest link first. */
    readonly rows: readonly TaskRow[];
    /** How many sessions worked on each, by task id. */
    readonly sessions: Readonly<Record<string, number>>;
}

/** What a project's page remembers between visits. */
export interface ProjectPageMemory {
    /** Plans expanded in place, as `owner/repo#n`. */
    readonly expandedPlans: readonly string[];
    readonly showClosed: boolean;
}

export interface ProjectPageState extends ProjectPageMemory {
    /** The project the rest belongs to; null until a page has opened. */
    readonly projectPath: string | null;
    /** The row the keyboard cursor is on, by the id its section gives it. */
    readonly cursor: string | null;
    readonly filter: string;
    /** Main's last answer for the project, or the one stored from an earlier visit; null until there is one. */
    readonly overview: ProjectOverview | null;
    /** What `overview` was asked with, and whether it is the stored one, being updated; null with no overview. */
    readonly overviewFrom: OverviewFrom | null;
    /** Show N more was clicked: the issues not in a plan are listed in full. */
    readonly looseExpanded: boolean;
    /** A session starting on one of the page's issues, or why the last one did not. */
    readonly start: ProjectIssueStart | null;
    /** Show merged: merged pull requests are listed after the open ones (#175). Not remembered. */
    readonly showMerged: boolean;
    /** A session starting in one of the project's worktrees, or why the last one did not (#175). */
    readonly worktreeStart: ProjectWorktreeStart | null;
    /** Clean removing the superfluous worktrees, or the ones git would not remove last time, with why. */
    readonly worktreeClean: ProjectWorktreeClean | null;
    /** The project's open tasks (#251); null until read, and while BlaakTasks is off. */
    readonly tasks: ProjectTasks | null;
    /** The merge queue's errands in the project's repository (#315); null until read. */
    readonly queueErrands: ProjectQueueErrands | null;
    /** The merge queue's buttons that are busy or have something to say, by `queueActionKey`. */
    readonly queueActions: Readonly<Record<string, QueueActionState>>;
    /** The CI job queue of the project's repository; null until read, and for a repository without a queue. */
    readonly ciJobQueue: ProjectCiJobQueue | null;
}

export interface OverviewFrom {
    readonly closed: boolean;
    readonly merged: boolean;
    /** Read back from storage as the page opened: shown while main is asked again. */
    readonly stored: boolean;
}

export type ProjectIssueStart =
    | {readonly issue: string; readonly phase: 'starting'}
    | {readonly issue: string; readonly phase: 'failed'; readonly reason: string};

export type ProjectWorktreeStart =
    | {readonly path: string; readonly phase: 'starting'}
    | {readonly path: string; readonly phase: 'failed'; readonly reason: string};

export type ProjectWorktreeClean =
    | {readonly phase: 'cleaning'}
    | {readonly phase: 'failed'; readonly failed: readonly {readonly path: string; readonly reason: string}[]};

export const NO_MEMORY: ProjectPageMemory = {expandedPlans: [], showClosed: false};

export const initialProjectPageState: ProjectPageState = {
    projectPath: null,
    ...NO_MEMORY,
    cursor: null,
    filter: '',
    overview: null,
    overviewFrom: null,
    looseExpanded: false,
    start: null,
    showMerged: false,
    worktreeStart: null,
    worktreeClean: null,
    tasks: null,
    queueErrands: null,
    queueActions: {},
    ciJobQueue: null,
};

export function projectPageReducer(state: ProjectPageState, event: RendererEvent): ProjectPageState {
    switch (event.type) {
        case 'projectPageRestored': {
            // The same project again keeps its last answer on screen until the next; else what was stored of it.
            const kept = state.projectPath === event.projectPath && state.overview !== null;
            const stored = event.stored ?? null;
            return {
                projectPath: event.projectPath,
                expandedPlans: event.memory.expandedPlans,
                showClosed: event.memory.showClosed,
                cursor: null,
                filter: '',
                overview: kept ? state.overview : (stored?.overview ?? null),
                overviewFrom: kept
                    ? state.overviewFrom
                    : stored
                      ? {closed: stored.closed, merged: stored.merged, stored: true}
                      : null,
                looseExpanded: false,
                start: null,
                showMerged: false,
                worktreeStart: null,
                worktreeClean: null,
                tasks: state.tasks?.projectPath === event.projectPath ? state.tasks : null,
                queueErrands: state.projectPath === event.projectPath ? state.queueErrands : null,
                queueActions: {},
                ciJobQueue: state.projectPath === event.projectPath ? state.ciJobQueue : null,
            };
        }

        case 'projectPlanToggled': {
            if (state.projectPath === null) return state;
            const open = state.expandedPlans.includes(event.plan);
            return {
                ...state,
                expandedPlans: open
                    ? state.expandedPlans.filter((p) => p !== event.plan)
                    : [...state.expandedPlans, event.plan],
            };
        }

        case 'projectPlanExpanded':
            if (state.projectPath === null || state.expandedPlans.includes(event.plan)) return state;
            return {...state, expandedPlans: [...state.expandedPlans, event.plan]};

        case 'projectPlanCollapsed':
            if (!state.expandedPlans.includes(event.plan)) return state;
            return {...state, expandedPlans: state.expandedPlans.filter((p) => p !== event.plan)};

        case 'projectOverviewAnswered':
            // An answer for another project, or one asked before Show closed or Show merged flipped, is old news.
            if (
                event.projectPath !== state.projectPath ||
                event.closed !== state.showClosed ||
                event.merged !== state.showMerged
            )
                return state;
            return overviewAnswered(state, event);

        case 'projectLooseExpanded':
            return state.looseExpanded ? state : {...state, looseExpanded: true};

        case 'projectIssueStartAsked':
            return state.projectPath === null ? state : {...state, start: {issue: event.issue, phase: 'starting'}};

        case 'projectIssueStartAnswered':
            if (state.start?.issue !== event.issue) return state;
            return {
                ...state,
                start: event.result.ok ? null : {issue: event.issue, phase: 'failed', reason: event.result.reason},
            };

        case 'projectShowClosedToggled':
            return state.projectPath === null ? state : {...state, showClosed: !state.showClosed};

        case 'projectShowMergedToggled':
            return state.projectPath === null ? state : {...state, showMerged: !state.showMerged};

        case 'projectWorktreeStartAsked':
            return state.projectPath === null
                ? state
                : {...state, worktreeStart: {path: event.path, phase: 'starting'}};

        case 'projectWorktreeStartAnswered':
            if (state.worktreeStart?.path !== event.path) return state;
            return {
                ...state,
                worktreeStart: event.result.ok
                    ? null
                    : {path: event.path, phase: 'failed', reason: event.result.reason},
            };

        case 'projectWorktreesCleanAsked':
            return state.projectPath === null ? state : {...state, worktreeClean: {phase: 'cleaning'}};

        case 'projectWorktreesCleanAnswered':
            if (event.projectPath !== state.projectPath || state.worktreeClean?.phase !== 'cleaning') return state;
            return {
                ...state,
                worktreeClean: event.result.failed.length === 0 ? null : {phase: 'failed', failed: event.result.failed},
            };

        case 'projectCursorMoved':
            return state.cursor === event.target ? state : {...state, cursor: event.target};

        case 'projectFilterChanged':
            return state.filter === event.filter ? state : {...state, filter: event.filter};

        case 'projectTasksAnswered':
            if (event.projectPath !== state.projectPath) return state;
            return {...state, tasks: {projectPath: event.projectPath, rows: event.rows, sessions: event.sessions}};

        // A row key from the Tasks page's actions: the row as it is now, or gone (Done, snoozed).
        case 'tasksRowChanged': {
            const tasks = state.tasks;
            if (!tasks || !tasks.rows.some((row) => row.id === event.taskId)) return state;
            const rows = event.row
                ? tasks.rows.map((row) => (row.id === event.taskId ? event.row! : row))
                : tasks.rows.filter((row) => row.id !== event.taskId);
            // The cursor stays on the same spot when its row leaves.
            let cursor = state.cursor;
            if (!event.row && cursor === 'task:' + event.taskId) {
                const at = tasks.rows.findIndex((row) => row.id === event.taskId);
                const next = rows[Math.min(at, rows.length - 1)];
                cursor = next ? 'task:' + next.id : null;
            }
            return {...state, cursor, tasks: {...tasks, rows}};
        }

        case 'projectQueueErrandsAnswered':
            if (state.projectPath === null) return state;
            return {...state, queueErrands: {repository: event.repository, errands: event.errands}};

        case 'projectQueueActionAsked':
            if (state.projectPath === null) return state;
            return {...state, queueActions: {...state.queueActions, [event.key]: {phase: 'busy'}}};

        case 'projectQueueActionAnswered': {
            if (!(event.key in state.queueActions)) return state;
            const {[event.key]: _was, ...others} = state.queueActions;
            return {
                ...state,
                queueActions: event.outcome.phase === 'done' ? others : {...others, [event.key]: event.outcome},
            };
        }

        case 'projectCiJobQueueAnswered': {
            if (state.projectPath === null) return state;
            // A failed read after a good one keeps the jobs it had on screen.
            const kept = state.ciJobQueue?.repository === event.repository && state.ciJobQueue.answer.ok;
            if (!event.answer.ok && kept) return state;
            return {...state, ciJobQueue: {repository: event.repository, answer: event.answer}};
        }

        case 'blaakTasksSwitched':
            return !event.on && state.tasks ? {...state, tasks: null} : state;

        default:
            return state;
    }
}

/**
 * Main's answer taken in. A full one always replaces what is held. One
 * without plans never takes a full one's place: over the full answer to the
 * same options it is dropped, and over the stored answer, or a full one asked
 * before Show closed or Show merged flipped, it brings its fresh parts (pull
 * requests, loose issues, the merge queue, worktrees, running sessions) and
 * leaves the plans, so they never fall back to a skeleton. When GitHub could
 * not be asked, the stored answer's GitHub part stays, marked stale, rather
 * than the message.
 */
function overviewAnswered(
    state: ProjectPageState,
    event: Extract<RendererEvent, {type: 'projectOverviewAnswered'}>,
): ProjectPageState {
    const answer = event.overview;
    const held = state.overview?.projectPath === event.projectPath ? state.overview : null;
    const from = held ? state.overviewFrom : null;
    const sameOptions = !!from && from.closed === event.closed && from.merged === event.merged;

    if (!event.plans && held && !(held.github?.ok && held.github.plansPending)) {
        if (sameOptions && !from?.stored) return state;
        return {...state, overview: withFreshParts(held, answer)};
    }
    const answered: OverviewFrom = {closed: event.closed, merged: event.merged, stored: false};
    if (sameOptions && from?.stored && held?.github?.ok && answer.github && !answer.github.ok)
        return {...state, overview: {...answer, github: {...held.github, stale: true}}, overviewFrom: answered};
    return {...state, overview: answer, overviewFrom: answered};
}

/** `held`, its plans kept, with the fresh parts of an answer without plans. */
function withFreshParts(held: ProjectOverview, answer: ProjectOverview): ProjectOverview {
    const github =
        held.github?.ok && answer.github?.ok
            ? {
                  ...held.github,
                  loose: answer.github.loose,
                  pullRequests: answer.github.pullRequests,
                  mergeQueue: answer.github.mergeQueue,
              }
            : held.github;
    return {...held, worktrees: answer.worktrees, running: answer.running, github};
}

/**
 * What the overview is asked for now (#174): the project, and whether closed
 * plans and (#175) merged pull requests are included, while the page shows its overview. Null while nothing
 * should be asked: the page closed, one of its plans on screen, or the moment
 * between the route opening a project and its memory (Show closed among it)
 * being read back.
 */
export function overviewRequest(state: RendererState): {projectPath: string; closed: boolean; merged: boolean} | null {
    const route = projectRoute(state.mainArea);
    if (!route || route.view.kind !== 'overview' || state.projectPage.projectPath !== route.projectPath) return null;
    return {projectPath: route.projectPath, closed: state.projectPage.showClosed, merged: state.projectPage.showMerged};
}

/**
 * The repository whose CI job queue the page shows now, to be read while it
 * does: the overview is on screen and its repository has a merge queue (so
 * the Merge queue section shows). Null otherwise: nothing is read.
 */
export function ciJobQueueRequest(state: RendererState): string | null {
    const request = overviewRequest(state);
    const overview = state.projectPage.overview;
    if (!request || overview?.projectPath !== request.projectPath || !overview.repository) return null;
    return overview.github?.ok && overview.github.mergeQueue ? overview.repository : null;
}

/** What the page remembers of its project, to persist. */
export function projectPageMemory(state: ProjectPageState): ProjectPageMemory {
    return {expandedPlans: state.expandedPlans, showClosed: state.showClosed};
}

/**
 * The row after (`step` 1) or before (-1) the cursor, in `rows`: every row
 * the page shows, in order, across its sections. From no cursor, or one on a
 * row that has gone, down starts at the first row and up at the last; the
 * ends hold.
 */
export function steppedCursor(rows: readonly string[], cursor: string | null, step: 1 | -1): string | null {
    if (!rows.length) return null;
    const at = cursor === null ? -1 : rows.indexOf(cursor);
    if (at === -1) return step === 1 ? rows[0] : rows[rows.length - 1];
    return rows[Math.min(rows.length - 1, Math.max(0, at + step))];
}

// ── Persistence ──
//
// Every project's memory is one JSON record under one localStorage key,
// keyed by project path. A project left as it opens (nothing expanded, closed
// hidden) is dropped from it rather than stored.

export type ProjectPageMemories = Readonly<Record<string, ProjectPageMemory>>;

/** The stored record, or an empty one when there is none or it is not ours. */
export function parseProjectPageMemories(stored: string | null): ProjectPageMemories {
    if (!stored) return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(stored);
    } catch {
        return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const memories: Record<string, ProjectPageMemory> = {};
    for (const [path, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') continue;
        const {expandedPlans, showClosed} = value as Record<string, unknown>;
        memories[path] = {
            expandedPlans: Array.isArray(expandedPlans)
                ? expandedPlans.filter((p): p is string => typeof p === 'string')
                : [],
            showClosed: showClosed === true,
        };
    }
    return memories;
}

/** `projectPath`'s memory, or the page as it first opens. */
export function memoryOf(memories: ProjectPageMemories, projectPath: string): ProjectPageMemory {
    return memories[projectPath] ?? NO_MEMORY;
}

/** `memories` with `projectPath`'s replaced by `memory`. */
export function remembered(
    memories: ProjectPageMemories,
    projectPath: string,
    memory: ProjectPageMemory,
): ProjectPageMemories {
    const {[projectPath]: _old, ...others} = memories;
    if (!memory.expandedPlans.length && !memory.showClosed) return others;
    return {...others, [projectPath]: {expandedPlans: memory.expandedPlans, showClosed: memory.showClosed}};
}
