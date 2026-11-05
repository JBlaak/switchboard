/**
 * The project page's overview (#173): the header, and the body's two columns,
 * the sections on the left and a 340 px column on the right.
 *
 * The page's keys (#174), while it has the focus and never in an input: ↑/↓
 * move the cursor through every row across sections, → and ← expand and
 * collapse a plan (← on an issue goes up to its plan), ↵ opens what is under
 * the cursor, S starts a session on it, / filters the rows, and Esc closes
 * the page, back to the session it covered, focused. What each key does is
 * `page-keys`; the rows it walks are `page-rows`.
 *
 * The body follows the GitHub part's state (#175, `page-state`): a project
 * with no GitHub remote, or an agentless remote one, has a single column of
 * what is local; a VM project (#276) is read on the VM, as a local one is;
 * when GitHub could not be asked, one message takes the place of Pull
 * requests and Plans; stale data is dimmed under a line saying how old it is.
 * Pull requests come first: checking one out is what the page is opened for
 * most, and they are answered before the plans. Over them, in a repository
 * that merges through a merge queue, the Merge queue section (#315).
 *
 * While BlaakTasks is on, the Tasks section (#251) lists the repo's open
 * tasks under Plans & issues (at the top of the one column without GitHub),
 * with the Tasks page's keys on its rows. Esc puts away a task's project
 * list, start answer or detail before it clears the filter or closes the page.
 */
import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import type {JSX, KeyboardEvent} from 'react';
import {dispatch, getState} from '../../state/app-store';
import {useStore} from '../use-store';
import {projectLabel} from '../../features/sessions/project-label';
import {ProjectHeader} from './ProjectHeader';
import {PlansSection} from './PlansSection';
import {SessionsSection, sessionsShown} from './SessionsSection';
import {PullRequestsSection} from './PullRequestsSection';
import {MergeQueueSection} from './MergeQueueSection';
import {mergeQueueOf} from './merge-queue-view';
import {WorktreesSection} from './WorktreesSection';
import {TasksSection} from './TasksSection';
import {GitHubMessage, RemoteNote, StaleLine} from './EdgeStates';
import {RegisterVmCard, useHostLink} from './VmLink';
import {CopiesSection, CopySection, SchedulesLine} from './HandoffSections';
import {isVmProjectIn} from '../../state/agent-host-slice';
import {
    closeProject,
    openIssueOnGitHub,
    openProjectSettings,
    openProjectPlan,
    openProjectSession,
    openPullRequestOnGitHub,
    startPageIssueSession,
    startWorktreeSession,
} from './actions';
import {openProjectTaskDetail, startProjectTask} from './project-tasks';
import {
    mergeQueueRows,
    pageRows,
    planRows,
    plansViewOf,
    pullRequestRows,
    pullRequestsViewOf,
    sessionRows,
    taskRows,
    tasksViewOf,
    worktreeRows,
    worktreesView,
    type PageRow,
} from './page-rows';
import {githubPart, showsTasks, showsWorktrees} from './page-state';
import {pageKeyAction, type PageKeyAction} from './page-keys';
import {
    closeProjectList,
    closeTaskDetail,
    dismissStart,
    markTaskDone,
    openTaskInNotion,
    snoozeTask,
    starTask,
} from '../tasks-page/actions';
import {isProjectSettingsKey} from '../../lib/shortcut-keys';

/** Every row on the page now, in the order the cursor walks them. */
function currentRows(projectPath: string): PageRow[] {
    const state = getState();
    const page = state.projectPage;
    const plans = plansViewOf(page, projectPath);
    const pullRequests = pullRequestsViewOf(page, projectPath);
    const sessions = sessionsShown(projectPath, state.view.activePtyIds, page.filter);
    const answered = page.overview?.projectPath === projectPath ? page.overview : null;
    const vm = isVmProjectIn(state.agentHost, projectPath);
    const worktrees = answered && showsWorktrees(answered, projectPath, vm) ? worktreesView(answered, page.filter) : [];
    const tasks = state.tasks.enabled && showsTasks(projectPath, vm) ? tasksViewOf(page, projectPath) : null;
    const queue = mergeQueueOf(page, projectPath);
    return pageRows({
        mergeQueue: queue && answered?.repository ? mergeQueueRows(answered.repository, queue) : [],
        plans: plans ? planRows(plans) : [],
        pullRequests: pullRequests ? pullRequestRows(pullRequests) : [],
        tasks: tasks ? taskRows(tasks) : [],
        sessions: sessionRows(sessions.lines.map((line) => line.session.sessionId)),
        worktrees: worktreeRows(worktrees),
    });
}

/** A task row's key (#251), carried out with the Tasks page's actions. */
function onTaskKey(projectPath: string, action: Extract<PageKeyAction, {kind: 'task'}>): void {
    const task = getState().projectPage.tasks?.rows.find((row) => row.id === action.taskId);
    if (!task) return;
    switch (action.key) {
        case 'start':
            void startProjectTask(projectPath, task);
            break;
        case 'star':
            void starTask(task);
            break;
        case 'done':
            void markTaskDone(task);
            break;
        case 'snooze':
            void snoozeTask(task);
            break;
        case 'notion':
            void openTaskInNotion(task.id);
            break;
        case 'detail':
            if (getState().tasks.detail?.taskId === task.id) closeTaskDetail();
            else openProjectTaskDetail(task.id);
            break;
    }
}

export function ProjectOverview({projectPath}: {projectPath: string}): JSX.Element {
    const root = useRef<HTMLDivElement>(null);
    const filterInput = useRef<HTMLInputElement>(null);
    const cursor = useStore((state) => state.projectPage.cursor);
    const filter = useStore((state) => state.projectPage.filter);
    const overview = useStore((state) => state.projectPage.overview);
    const vm = useStore((state) => isVmProjectIn(state.agentHost, projectPath));
    const github = githubPart(overview, projectPath, vm);
    const [filtering, setFiltering] = useState(false);

    // Into the page as it opens, so its keys reach it without a click.
    useLayoutEffect(() => {
        root.current?.focus({preventScroll: true});
    }, [projectPath]);

    // The row under the cursor stays in view.
    useEffect(() => {
        if (!cursor) return;
        root.current?.querySelector(`[data-cursor-id="${CSS.escape(cursor)}"]`)?.scrollIntoView({block: 'nearest'});
    }, [cursor]);

    useLayoutEffect(() => {
        if (filtering) filterInput.current?.focus();
    }, [filtering]);

    const closeFilter = (clear: boolean): void => {
        if (clear) dispatch({type: 'projectFilterChanged', filter: ''});
        setFiltering(false);
        root.current?.focus({preventScroll: true});
    };

    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
        if (isProjectSettingsKey(e.nativeEvent)) {
            e.preventDefault();
            openProjectSettings(projectPath);
            return;
        }
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if ((e.target as HTMLElement).matches('input, textarea, select, [contenteditable="true"]')) return;
        if (e.key === 'Escape' && !e.shiftKey) {
            e.preventDefault();
            const tasks = getState().tasks;
            if (tasks.picker) closeProjectList();
            else if (tasks.start?.phase === 'answered') dismissStart();
            else if (tasks.detail) closeTaskDetail();
            else if (filter) dispatch({type: 'projectFilterChanged', filter: ''});
            else closeProject();
            return;
        }
        // S and * are the only keys that come shifted as well; the rest are bare.
        if (e.shiftKey && e.key !== 'S' && e.key !== '*') return;
        const action = pageKeyAction(e.key, currentRows(projectPath), getState().projectPage.cursor);
        if (!action) return;
        e.preventDefault();
        switch (action.kind) {
            case 'cursor':
                dispatch({type: 'projectCursorMoved', target: action.target});
                break;
            case 'expand':
                dispatch({type: 'projectPlanExpanded', plan: action.plan});
                break;
            case 'collapse':
                dispatch({type: 'projectPlanCollapsed', plan: action.plan});
                break;
            case 'open-plan':
                openProjectPlan(projectPath, action.plan);
                break;
            case 'open-issue':
                openIssueOnGitHub(action.issue);
                break;
            case 'open-session':
                openProjectSession(action.sessionId);
                break;
            case 'show-more-loose':
                dispatch({type: 'projectLooseExpanded'});
                break;
            case 'start':
                void startPageIssueSession(projectPath, action.issue, action.plan);
                break;
            case 'open-pull-request':
                openPullRequestOnGitHub(action.pullRequest);
                break;
            case 'start-worktree':
                void startWorktreeSession(projectPath, action.path);
                break;
            case 'task':
                onTaskKey(projectPath, action);
                break;
            case 'filter':
                setFiltering(true);
                break;
        }
    };

    const onFilterKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closeFilter(true);
        } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
            // Back to the rows, the cursor on the first that is left.
            e.preventDefault();
            e.stopPropagation();
            const first = currentRows(projectPath)[0];
            dispatch({type: 'projectCursorMoved', target: first?.id ?? null});
            closeFilter(false);
        }
    };

    return (
        <div
            ref={root}
            className="sw-page project-page"
            tabIndex={-1}
            role="region"
            aria-label={'Project ' + projectLabel(projectPath)}
            onKeyDown={onKeyDown}>
            <ProjectHeader projectPath={projectPath} />
            {(filtering || filter) && (
                <div className="pp-filter">
                    <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        aria-hidden="true">
                        <circle cx="11" cy="11" r="7" />
                        <path d="m20 20-4-4" />
                    </svg>
                    <input
                        ref={filterInput}
                        type="text"
                        className="pp-filter-input"
                        aria-label="Filter rows"
                        placeholder="Filter rows"
                        value={filter}
                        spellCheck={false}
                        onChange={(e) => dispatch({type: 'projectFilterChanged', filter: e.target.value})}
                        onKeyDown={onFilterKeyDown}
                        onBlur={() => {
                            if (!getState().projectPage.filter) setFiltering(false);
                        }}
                    />
                    <kbd className="sw-kbd">esc</kbd>
                </div>
            )}
            {github.kind === 'remote' || github.kind === 'none' ? (
                <div className="pp-body is-local">
                    <div className="pp-column">
                        {github.kind === 'none' && <TasksSection projectPath={projectPath} />}
                        <SessionsSection projectPath={projectPath} />
                        {github.kind === 'remote' ? (
                            <>
                                <RegisterHost projectPath={projectPath} />
                                <RemoteNote />
                            </>
                        ) : (
                            <>
                                <WorktreesSection projectPath={projectPath} />
                                <ProjectCopies projectPath={projectPath} vm={vm} />
                            </>
                        )}
                    </div>
                </div>
            ) : (
                <div className="pp-body">
                    <div className={'pp-column' + (github.kind === 'ok' && github.stale ? ' is-stale' : '')}>
                        {github.kind === 'ok' && github.stale && <StaleLine fetchedAt={github.fetchedAt} />}
                        {github.kind === 'unavailable' ? (
                            <GitHubMessage reason={github.reason} />
                        ) : (
                            <>
                                <MergeQueueSection projectPath={projectPath} />
                                <PullRequestsSection projectPath={projectPath} />
                                <PlansSection projectPath={projectPath} />
                            </>
                        )}
                        <TasksSection projectPath={projectPath} />
                    </div>
                    <div className="pp-column pp-side">
                        <SessionsSection projectPath={projectPath} />
                        <WorktreesSection projectPath={projectPath} />
                        <ProjectCopies projectPath={projectPath} vm={vm} />
                    </div>
                </div>
            )}
        </div>
    );
}

/** On an agentless remote whose host isn't registered (#307): Register this host as a VM. */
function RegisterHost({projectPath}: {projectPath: string}): JSX.Element | null {
    const link = useHostLink(projectPath);
    return link?.kind === 'register' ? <RegisterVmCard link={link} /> : null;
}

/**
 * Under Worktrees: on a VM copy (#276) its Bring back and Remove copy; on a
 * local project, its copies on VMs. Under either, where the schedules run
 * (stage 5). The VM's setup is in Settings → VMs (#307).
 */
function ProjectCopies({projectPath, vm}: {projectPath: string; vm: boolean}): JSX.Element {
    return vm ? (
        <>
            <CopySection projectPath={projectPath} />
            <SchedulesLine projectPath={projectPath} />
        </>
    ) : (
        <>
            <CopiesSection projectPath={projectPath} />
            <SchedulesLine projectPath={projectPath} />
        </>
    );
}
