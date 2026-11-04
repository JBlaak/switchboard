/**
 * The project page's work outside React (#173, #174): its memory read back
 * from localStorage as the page opens on a project, and written as it
 * changes; and the project's overview (#172), asked for as the overview comes
 * on screen and every 60 s while it stays there. Each full answer is stored
 * (`stored-overviews`), and read back as the page opens on the project again,
 * so it shows at once while main is asked.
 *
 * The panel is swapped in by the main area's route
 * (`ui/main-area/install-main-area`), and a plan inside the page is opened by
 * `ui/plan-page/install-plan-page`, which polls that plan itself. Nothing is
 * asked while the page is closed or shows one of its plans.
 *
 * The project's open tasks (#251) are read the same way, only while
 * BlaakTasks is on: as the overview comes on screen, every 60 s, and soon
 * after a session's task or the tasks' links change (a start, Change repo).
 *
 * The merge queue's errands (#315) have no push: they are read again with
 * each full overview whose repository has a queue, after main is told which
 * held entries wait for a review now. The section's effects are handed in
 * here too.
 */
import {dispatch, store} from '../../state/app-store';
import {projectRoute} from '../../state/main-area-slice';
import {
    memoryOf,
    overviewRequest,
    parseProjectPageMemories,
    projectPageMemory,
    remembered,
} from '../../state/project-page-slice';
import type {RendererState} from '../../state/root';
import {STORAGE_KEYS, readStored, writeStored} from '../../state/storage';
import {isVmProjectIn} from '../../state/agent-host-slice';
import {isStorable, parseStoredOverviews, storedOverviewFor, storedOverviewsWith} from '../../state/stored-overviews';
import {issueKeyString} from '../../../domain/plan/model';
import {loadProjectOverview, reloadProjectOverview} from './actions';
import {followQueueErrands, setMergeQueueEffects} from './merge-queue-actions';
import {resolveDefaultSessionOptions} from '../../features/dialogs/launch-options';
import {startClaudeSessionIn} from '../../features/sessions/session-actions';
import {pulseSessionRow} from '../session-list/pulse';
import {loadProjectTasks, tasksRequest} from './project-tasks';
import {recentPlansIn, withRecentPlan} from './recent-plans';

/** How often an open project page asks for its overview again (#167: 60 s, while it is open). */
export const OVERVIEW_POLL_MS = 60_000;

/** How long the tasks wait after a change before they are read again, so a burst of changes is read once. */
export const TASKS_SETTLE_MS = 250;

/** Start following the route. Answers a teardown. */
export function installProjectPage(): () => void {
    setMergeQueueEffects({
        confirm: (message) => confirm(message),
        launch: async (directory, projectPath, prompt) => {
            try {
                // In the project, or in its worktree already: `--worktree` would make another.
                const {
                    worktree: _worktree,
                    worktreeName: _worktreeName,
                    ...options
                } = await resolveDefaultSessionOptions(projectPath);
                return await startClaudeSessionIn(directory, {...options, initialPrompt: prompt}, {show: false});
            } catch (err) {
                return {ok: false, reason: (err as Error).message || 'Could not start the session'};
            }
        },
        pulse: pulseSessionRow,
        reload: reloadProjectOverview,
    });

    let polling: string | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let tasksFor: string | null = null;
    let tasksPoll: ReturnType<typeof setInterval> | null = null;
    let settling: ReturnType<typeof setTimeout> | null = null;

    const followTasks = (state: RendererState): void => {
        const projectPath = tasksRequest(state);
        if (projectPath === tasksFor) return;
        tasksFor = projectPath;
        if (tasksPoll) clearInterval(tasksPoll);
        tasksPoll = null;
        if (!projectPath) return;
        void loadProjectTasks(projectPath);
        tasksPoll = setInterval(() => void loadProjectTasks(projectPath), OVERVIEW_POLL_MS);
    };

    const tasksChangedSoon = (): void => {
        if (!tasksFor) return;
        if (settling) clearTimeout(settling);
        settling = setTimeout(() => {
            settling = null;
            if (tasksFor) void loadProjectTasks(tasksFor);
        }, TASKS_SETTLE_MS);
    };

    const follow = (state: RendererState): void => {
        const request = overviewRequest(state);
        const key = request ? [request.projectPath, request.closed, request.merged].join('\0') : null;
        if (key === polling) return;
        polling = key;
        if (poll) clearInterval(poll);
        poll = null;
        if (!request) return;
        const load = (): void => {
            void loadProjectOverview(request.projectPath, request.closed, request.merged);
        };
        load();
        poll = setInterval(load, OVERVIEW_POLL_MS);
    };

    const unsubscribe = store.subscribe((state, previous, event) => {
        followTasks(state);
        if (event.type === 'sessionTaskChanged' || event.type === 'tasksLinksLoaded') tasksChangedSoon();
        // A session started from the section: its worktree shows on the page.
        if (tasksFor && event.type === 'tasksStartAnswered' && event.outcome.kind === 'started')
            reloadProjectOverview();

        if (state.mainArea !== previous.mainArea) {
            const was = projectRoute(previous.mainArea);
            const now = projectRoute(state.mainArea);
            // Opened, or another project's page took its place: a fresh cursor and
            // filter, and this project's plans as they were left, with the plan
            // viewed last expanded too.
            if (now && now.projectPath !== was?.projectPath) {
                const stored = memoryOf(
                    parseProjectPageMemories(readStored('localStorage', STORAGE_KEYS.projectPages)),
                    now.projectPath,
                );
                const memory = withRecentPlan(stored, recentPlansIn(now.projectPath));
                // Show merged starts off on every visit.
                const overview = storedOverviewFor(
                    parseStoredOverviews(readStored('localStorage', STORAGE_KEYS.projectOverviews)),
                    now.projectPath,
                    memory.showClosed,
                    false,
                );
                dispatch({type: 'projectPageRestored', projectPath: now.projectPath, memory, stored: overview});
                return;
            }
            // Back from one of its plans: that plan, viewed last, is expanded.
            if (now && was && now.view.kind === 'overview' && was.view.kind === 'plan') {
                dispatch({type: 'projectPlanExpanded', plan: issueKeyString(was.view)});
            }
        }

        follow(state);

        // A full answer the page took as it is: kept for the next visit.
        if (
            event.type === 'projectOverviewAnswered' &&
            event.plans &&
            state.projectPage.overview === event.overview &&
            isStorable(event.overview, isVmProjectIn(state.agentHost, event.overview.projectPath))
        ) {
            const stored = parseStoredOverviews(readStored('localStorage', STORAGE_KEYS.projectOverviews));
            const entry = {overview: event.overview, closed: event.closed, merged: event.merged};
            writeStored('localStorage', STORAGE_KEYS.projectOverviews, storedOverviewsWith(stored, entry));
        }

        // A full answer with a merge queue: its errands, read again (#315).
        if (event.type === 'projectOverviewAnswered' && event.plans && state.projectPage.overview === event.overview) {
            const {repository, github} = event.overview;
            if (repository && github?.ok && github.mergeQueue) void followQueueErrands(repository, github.mergeQueue);
        }

        const page = state.projectPage;
        const before = previous.projectPage;
        if (page.projectPath === null || page.projectPath !== before.projectPath) return;
        if (page.expandedPlans === before.expandedPlans && page.showClosed === before.showClosed) return;
        const memories = parseProjectPageMemories(readStored('localStorage', STORAGE_KEYS.projectPages));
        const next = remembered(memories, page.projectPath, projectPageMemory(page));
        writeStored('localStorage', STORAGE_KEYS.projectPages, JSON.stringify(next));
    });

    return () => {
        if (poll) clearInterval(poll);
        if (tasksPoll) clearInterval(tasksPoll);
        if (settling) clearTimeout(settling);
        unsubscribe();
    };
}
