/**
 * The whole contract between the main process and the renderer.
 *
 * The renderer reaches main through nothing else, and it declares `window.api`
 * against this interface — which is what makes an IPC rename a compile error
 * rather than a runtime `undefined`. The main process registers handlers named
 * from the same channel table, so the two sides cannot drift apart silently.
 */
import type {Project} from '../domain/project/project';
import type {RemoteConfig} from '../domain/project/remote-target';
import type {ProjectFolderCheck} from '../domain/project/folder-check';
import type {RemoteStatusPayload} from '../domain/remote/remote-status';
import type {SearchResult, SearchType} from '../domain/search/search';
import type {SessionOptions} from '../domain/launch/session-options';
import type {EffectiveSettings} from '../domain/settings/settings';
import type {Appearance} from '../domain/settings/appearance';
import type {SavedPrompt, SavedPromptLists} from '../domain/settings/saved-prompts';
import type {Answers, PendingQuestions, QuestionsSettled} from '../domain/questions/question';
import type {ShellProfile} from '../domain/shell/shell-profile';
import type {GrillAnswer, GrillChanged, GrillResult, GrillView} from '../domain/grill/model';
import type {SessionWorkDiff, SessionWorkSnapshot} from '../domain/session-work/model';
import type {PullRequestStatusChange} from '../domain/session-work/status';
import type {MergeQueueChange} from '../domain/project/queue-elsewhere';
import type {BumpRequest, BumpResult, CiJobQueueAnswer} from '../domain/project/ci-job-queue';
import type {CommentRequest, ReviewRequest, ReviewResult} from '../domain/session-work/review';
import type {WorkingAgent} from '../domain/terminal/program-status-children';
import type {BackgroundTask} from '../domain/session/background-tasks';
import type {UpdateNotice} from '../domain/update/release';
import type {InstallProgress, InstallResult, UpdateOutcome} from '../domain/update/progress';
import type {Usage} from '../domain/usage/usage';
import type {WorkspaceActionResult, WorkspaceEditorInfo, WorkspaceTarget} from '../domain/workspace/model';
import type {Weather, WeatherLocation} from '../domain/weather/weather';
import type {AskPatchResult, CaptureTarget, RouteRequest} from '../domain/ask/model';
import type {IssueWorktreeRequest, IssueWorktreeResult} from '../domain/plan/issue-session';
import type {Plan, PlanSummary} from '../domain/plan/model';
import type {ProjectOverview, ProjectOverviewOptions, WorktreeCleanResult} from '../domain/project/overview';
import type {
    ErrandResult,
    FixRequest,
    FixResult,
    NudgeRequest,
    NudgeResult,
    QueueErrandView,
} from '../domain/project/queue-errands';
import type {PhoneAccessState, TerminalOwner} from '../domain/phone/state';
import type {BlaakTasksResult, TaskDetail, TaskRow} from '../domain/tasks/model';
import type {BugsnagProjectChange, TrendingThresholds} from '../domain/bugsnag/connection';
import type {BugsnagConnectionView} from '../application/services/bugsnag-connection-service';
import type {
    MarkDoneOffer,
    TaskChange,
    TaskQuery,
    TaskSessions,
    TaskStartPreparation,
    TaskStartRequest,
    TaskUpdateResult,
    TasksUpdate,
} from '../domain/tasks/surface';
import type {AgentHostStatus, AgentHostsResult} from '../application/services/agent-hosts';
import type {HostSettings, ToolCheck} from '../domain/agent/protocol';
import type {
    BringBackResult,
    CopyStatus,
    HandoffHost,
    HandoffPreview,
    HandoffChoices,
    HandoffResult,
    StartHandoffResult,
    ProjectCopy,
} from '../application/services/project-handoff';
import type {SessionHandoffPhase, SessionHandoffPreview} from '../application/services/session-handoff';
import type {SessionBringBackPhase, SessionBringBackPreview} from '../application/services/session-bring-back';
import type {ExistingBranchChoice} from '../domain/project/branch-worktree';
import type {ScheduleLocation} from '../application/services/vm-schedules';
import type {VmHostView} from '../application/services/vm-registry';
import type {ShownPage} from '../domain/session/page-tool';
import type {SessionLink} from '../domain/session/links';
import type {SessionStats} from '../domain/session/stats';
import type {ReleaseTagsView, SnoozeOptionView} from '../application/services/inbox-settings-service';
import type {InboxItem, InboxManager, InboxSummary} from '../domain/inbox/model';
import type {IssueThread} from '../domain/inbox/issue-manager';
import type {IssueStartPrepared, IssueWriteResult, PolishResult} from '../application/services/issue-manager-service';
import type {MergeManagerState} from '../domain/merge-manager/model';
import type {LandResult} from '../application/services/merge-manager-service';
import type {GitHubWrite} from '../application/ports/github-cli';
import type {BugDetail, FixPreparation} from '../application/services/bug-fix-service';

export type {AgentHostStatus, AgentHostsResult, VmHostView};
export type {Editor, WorkspaceActionResult, WorkspaceEditorInfo, WorkspaceTarget} from '../domain/workspace/model';

/** Removes the listener an `on*` subscription added. */
export type Unsubscribe = () => void;

/** The `{ ok }`/`{ error }` envelope most handlers answer with. */
export interface IpcResult {
    ok?: boolean;
    error?: string;
    [key: string]: unknown;
}

export interface SwitchboardApi {
    // ── Projects ──
    getProjects(showArchived: boolean): Promise<Project[]>;
    browseFolder(): Promise<string | null>;
    addProject(projectPath: string): Promise<IpcResult>;
    removeProject(projectPath: string): Promise<IpcResult>;
    addRemoteProject(config: Partial<RemoteConfig>): Promise<IpcResult>;
    removeRemoteProject(projectPath: string): Promise<IpcResult>;
    /**
     * What adding the typed path would add: whether it is there, a repository,
     * on GitHub, and how far Tab completes it. A leading `~` is expanded.
     */
    checkProjectFolder(typed: string): Promise<ProjectFolderCheck>;

    // ── Sessions ──
    getActiveSessions(): Promise<string[]>;
    getActiveTerminals(): Promise<{sessionId: string; projectPath: string}[]>;
    openTerminal(id: string, projectPath: string, isNew: boolean, sessionOptions?: SessionOptions): Promise<IpcResult>;
    stopSession(id: string): Promise<IpcResult>;
    reconnectRemote(id: string): Promise<IpcResult>;
    toggleStar(id: string): Promise<{starred: number}>;
    /** Pin a plan (the sessions sharing `slug` in one project) to the top of the list, or unpin it. */
    togglePlanPin(projectPath: string, slug: string): Promise<{pinned: boolean}>;
    /** Pin a GitHub plan, from its page in a project, to the top of the list, or unpin it. */
    toggleIssuePlanPin(
        projectPath: string,
        repository: string,
        number: number,
        title: string,
    ): Promise<{pinned: boolean}>;
    /** Pin a project, from its page, to the top of the list above the pinned plans, or unpin it. */
    toggleProjectPin(projectPath: string): Promise<{pinned: boolean}>;
    /** `null` clears the rename, falling back to the AI/first-prompt title. */
    renameSession(id: string, name: string | null): Promise<IpcResult>;
    /**
     * Archive a session, or bring it back. Archiving a session of a task whose
     * PRs are all merged answers `markDone`: offer to mark that task done (#248).
     */
    archiveSession(id: string, archived: boolean): Promise<{archived: number; markDone?: MarkDoneOffer}>;
    /** Keep a session's row out of the list until `until` (an ISO time), or wake it with null. */
    snoozeSession(id: string, until: string | null): Promise<void>;
    /**
     * A session's context used, message count, start time, branch and shell,
     * for the session tray (#341). Read fresh on every call; each field is
     * null when it is not known (an agentless remote has no transcript or git
     * here). An unknown id answers all nulls.
     */
    getSessionStats(id: string): Promise<SessionStats>;

    // ── Questions ──
    /** Every set of questions a running session is blocked on, for a renderer that (re)loads. */
    getPendingQuestions(): Promise<PendingQuestions[]>;
    /** Send the answers; `{ ok: false }` when the questions were already withdrawn. */
    answerQuestions(sessionId: string, toolUseId: string, answers: Answers): Promise<IpcResult>;

    // ── Grilling rounds ──
    /** Every open grilling round with its draft answers, for a renderer that (re)loads. */
    grillViews(): Promise<GrillView[]>;
    /** Set or clear (null) the draft answer at `place`, given against `revision` of the round. */
    grillAnswer(
        sessionId: string,
        roundId: string,
        revision: number,
        place: number,
        answer: GrillAnswer | null,
    ): Promise<GrillResult>;
    /** Ask about the question at `place` with `text`, or Wait, what? when `text` is null. */
    grillAsk(
        sessionId: string,
        roundId: string,
        revision: number,
        place: number,
        text: string | null,
    ): Promise<GrillResult>;
    /** Type the round's answers into the session now. */
    grillSend(sessionId: string, roundId: string): Promise<GrillResult>;
    /** Send the answers once the session's research agents are done. */
    grillQueue(sessionId: string, roundId: string): Promise<GrillResult>;
    /** Take back a queued send. */
    grillCancelQueue(sessionId: string, roundId: string): Promise<GrillResult>;

    // ── Usage ──
    getUsage(): Promise<Usage | null>;

    // ── Weather ──
    /** Null when weather is switched off or could not be fetched. */
    getWeather(): Promise<Weather | null>;
    /** The best match for a city name, or null when there is none. */
    geocodeWeatherLocation(name: string): Promise<WeatherLocation | null>;

    // ── Ask Patch ──
    /**
     * Which project the user's text is about, and the prompt to start it on.
     * Never rejects: a failed call answers `{ kind: 'failed' }`.
     */
    askRoute(request: RouteRequest): Promise<AskPatchResult>;
    /** Stop the request in flight; it then answers `{ kind: 'cancelled' }`. */
    cancelAskRoute(): Promise<void>;
    /** Start a `claude` process for the next request now, so it answers sooner; one at a time. */
    warmAskRoute(): Promise<void>;

    // ── Sleep ──
    /** True when `pmset disablesleep 1` is in effect; null when it cannot be read (not a Mac). */
    getSleepDisabled(): Promise<boolean | null>;
    /** Flip the switch (may show the macOS password prompt); answers with the state read back. */
    setSleepDisabled(disabled: boolean): Promise<boolean | null>;

    // ── Updates ──
    /** A newer release waiting to be installed, or null. */
    getUpdate(): Promise<UpdateNotice | null>;
    /** Download and swap in the waiting update, then relaunch. False when it could not. */
    installUpdate(): Promise<InstallResult>;
    /** How the install before this launch went; null when there was none. */
    getUpdateOutcome(): Promise<UpdateOutcome | null>;

    // ── Search ──
    search(type: SearchType, query: string, titleOnly: boolean): Promise<SearchResult[]>;

    // ── Settings ──
    getSetting<T = unknown>(key: string): Promise<T | null>;
    setSetting(key: string, value: unknown): Promise<IpcResult>;
    getEffectiveSettings(projectPath: string | null): Promise<EffectiveSettings>;
    getShellProfiles(): Promise<ShellProfile[]>;
    /**
     * Persist the colour scheme and apply it.
     *
     * A channel of its own rather than `setSetting`: storing the value is only
     * half of it, main also has to hand it to Electron.
     */
    setAppearance(mode: Appearance): Promise<IpcResult>;
    /**
     * Whether main holds ⌥Space for Quick Ask, false when it is off or another
     * app has it; and the capture targets whose server isn't set up in Claude Code.
     */
    quickAskHotkeyStatus(): Promise<{registered: boolean; missing: CaptureTarget[]}>;
    /** Whether a server in `~/.claude.json` has this BlaakTasks URL (#252). Never the token itself. */
    blaakTasksSetUp(url: string): Promise<boolean>;
    /** The cycle the Planner at `url` says today is in (#412), for the Settings field's "✓ cycle N"; null when it gave none. */
    plannerCycle(url: string): Promise<{number: number} | null>;
    /** The managers' snooze options open now (#412), with the cycle ones when the Planner answers within 5 s. */
    inboxSnoozeOptions(): Promise<SnoozeOptionView[]>;
    /** Both managers' unread and urgent counts (#413), as `onInboxChanged` pushes them. */
    inboxSummary(): Promise<InboxSummary>;
    /** A manager's inbox items, in every state. */
    inboxItems(manager: InboxManager): Promise<InboxItem[]>;
    /** An unread item was seen; the item after, or null for a key the inbox does not hold. */
    inboxMarkRead(key: string): Promise<InboxItem | null>;
    /** Snooze an item until a time (ISO), or until it changes (null). */
    inboxSnooze(key: string, until: string | null): Promise<InboxItem | null>;
    /** Put an item in the backlog, until it changes. */
    inboxBacklog(key: string): Promise<InboxItem | null>;
    /** Your notes on an item, saved as you type. */
    inboxSetNotes(key: string, notes: string): Promise<InboxItem | null>;
    /** An Issue manager issue's ticket and newest comments (#415); null when GitHub did not answer. */
    issueManagerThread(key: string): Promise<IssueThread | null>;
    /** Your notes polished into a comment by Claude, for the preview, with the line posting adds. */
    issueManagerPolish(key: string, notes: string): Promise<PolishResult>;
    /** Post a comment on the issue, the footer added after it. */
    issueManagerPost(key: string, body: string): Promise<IssueWriteResult>;
    /** Polish your notes and post the comment straight away. */
    issueManagerPolishAndPost(key: string, notes: string): Promise<IssueWriteResult>;
    /**
     * Start and claim: assign you, then make the issue's worktree and the
     * prompt with its ticket, thread and your notes. The renderer starts the
     * session there and says so with `issueManagerStarted`.
     */
    issueManagerPrepareStart(key: string): Promise<IssueStartPrepared>;
    /** A Start session is running on the issue: it is in progress, on that branch. */
    issueManagerStarted(key: string, branch: string, sessionId: string | null): Promise<InboxItem | null>;
    /** Stop working on it: back in the inbox, and off the issue on GitHub when `unassign`. */
    issueManagerStopWork(key: string, unassign: boolean): Promise<{item: InboxItem | null; warning?: string}>;
    /** The Merge manager's lanes (#434), as `onMergeManagerChanged` pushes them. */
    mergeManagerState(): Promise<MergeManagerState>;
    /** Land your own open, non-draft PR: it joins its repository's lane. */
    mergeManagerLand(repository: string, number: number): Promise<LandResult>;
    /** Unland a PR: it leaves its lane without merging. */
    mergeManagerUnland(repository: string, number: number): Promise<GitHubWrite>;
    /** When the inbox last polled Bugsnag and GitHub, epoch ms (#414); null before it did. */
    inboxPolledAt(): Promise<number | null>;
    /** Fix (#414): the worktree and prompt of a Fix session on a bug, or why not ("Link a project first"). */
    bugPrepareFix(key: string): Promise<FixPreparation>;
    /** The Fix session `bugPrepareFix` prepared started: the bug moves to In progress. */
    bugFixStarted(key: string, sessionId: string): Promise<InboxItem | null>;
    /** Stop working on a bug: back in the inbox, read. */
    bugStopWorking(key: string): Promise<InboxItem | null>;
    /** Seen again from an older release: mark it fixed in Bugsnag again and keep it in Done. */
    bugCloseAgain(key: string): Promise<InboxItem | null>;
    /** Seen again after the merge, taken as a regression: back in the inbox, unread. */
    bugTreatAsRegressed(key: string): Promise<InboxItem | null>;
    /** A bug's detail from Bugsnag: its 7-day trend, first and last release, top frames, dashboard link. */
    bugDetail(key: string): Promise<BugDetail | null>;
    /** A bug's events per day for the last 7 days, oldest first, for its row's sparkline. */
    bugTrend(key: string): Promise<number[]>;
    /** Releases are tagged for a project (#412): what its tags say, its own override, and what counts. */
    releaseTags(projectPath: string): Promise<ReleaseTagsView>;
    /**
     * Settings → Bug manager (#411): the token's last four characters, what
     * trying it said, the projects it sees with their opt-in and link, the
     * trending thresholds. The token itself never comes here.
     */
    bugsnagConnection(): Promise<BugsnagConnectionView>;
    /** Try a Bugsnag token and save it in the Keychain when Bugsnag accepts it; the view after. */
    bugsnagSaveToken(token: string): Promise<BugsnagConnectionView>;
    /** Forget the Bugsnag token; the view after. */
    bugsnagRemoveToken(): Promise<BugsnagConnectionView>;
    /** Opt a Bugsnag project in or out, or link it to a local project (null unlinks). */
    bugsnagSetProject(id: string, change: BugsnagProjectChange, name?: string): Promise<IpcResult>;
    /** Store the trending thresholds; answers them as stored. */
    bugsnagSetTrending(trending: TrendingThresholds): Promise<TrendingThresholds>;
    /**
     * The saved prompts (#339): the global list, and the project's when a path
     * is given. Order them for the tray with `resolveSavedPrompts`.
     */
    savedPrompts(projectPath: string | null): Promise<SavedPromptLists>;
    /**
     * Replace one stored list of saved prompts: the global one for null, else
     * the project's. Main merges it into the blob, so no other key is touched.
     * Answers the list as stored (entries without an id or text dropped).
     */
    setSavedPrompts(projectPath: string | null, prompts: readonly SavedPrompt[]): Promise<SavedPrompt[]>;

    // ── Host ──
    openExternal(url: string): Promise<void>;
    /** Open the project's `origin` in the browser; false when it has none with a web page. */
    openRepository(projectPath: string): Promise<boolean>;
    writeClipboard(text: string): Promise<void>;
    /** Copy a PNG to the clipboard. */
    writeClipboardImage(png: Uint8Array): Promise<void>;
    getAppVersion(): Promise<string>;

    // ── Workspace actions: the session tray's Workspace group (#342) ──
    // Each takes `{sessionId}` (the session's working directory) or
    // `{directory}`. A remote (ssh/VM) session answers `NOT_AVAILABLE_REMOTE`.
    /** The IDE Open in editor would use, e.g. `app: 'PhpStorm'` for the button's label. */
    workspaceEditor(target: WorkspaceTarget): Promise<WorkspaceEditorInfo>;
    /** Open the folder in the IDE that matches the repo; a missing one falls back to Sublime Text, then Finder. */
    openInEditor(target: WorkspaceTarget): Promise<WorkspaceActionResult>;
    /** Open the folder in a Finder window. */
    revealInFinder(target: WorkspaceTarget): Promise<WorkspaceActionResult>;
    /** Open a shell in the folder: iTerm when installed, else Terminal. Not a Switchboard session. */
    shellHere(target: WorkspaceTarget): Promise<WorkspaceActionResult>;

    // ── Session work ──
    /**
     * Open the Session work page for a session, closing whichever was open.
     * Answers the first snapshot (later ones arrive on `onSessionWorkSnapshot`),
     * or null when the page cannot open for this session.
     */
    openSessionWork(sessionId: string): Promise<SessionWorkSnapshot | null>;
    /** False for remote sessions and for sessions outside a git repository (D14). */
    canOpenSessionWork(sessionId: string): Promise<boolean>;

    // ── Session links (#340) ──
    /**
     * What the session produced or refers to, for the session tray's Links
     * group: its PRs, issues, artifacts, pages and task, in that order and
     * each kind newest first (see `domain/session/links`). Answers from what
     * main has kept and never waits on `gh` or BlaakTasks: what has gone stale
     * is asked again behind the answer, so the next call has it.
     */
    getSessionLinks(sessionId: string): Promise<SessionLink[]>;
    /** The parsed diff of one item (`SessionWorkItem.id`) of the open page, and where it came from. */
    getSessionWorkDiff(request: {sessionId: string; itemId: string}): Promise<SessionWorkDiff>;
    /**
     * One side of an image (`FileDiff.image`) in an item's local diff, as bytes;
     * null when there is none. Only a file in that diff can be named, and it is
     * read at the commits the diff was made from (L3).
     */
    sessionWorkImage(request: {
        sessionId: string;
        itemId: string;
        path: string;
        side: 'before' | 'after';
    }): Promise<Uint8Array | null>;
    /** Add a line comment to your pending review on a PR item, starting the review if there is none (C1, C2). */
    sessionWorkComment(request: CommentRequest): Promise<ReviewResult>;
    /** Finish your pending review on a PR item: submit it (and hand its threads to Claude), or discard it (C2). */
    sessionWorkReview(request: ReviewRequest): Promise<ReviewResult>;
    /** The end of a failing check run's log, for the Checks panel; null when `gh` has none. */
    getCheckLog(request: {repository: string; checkRunUrl: string}): Promise<string | null>;

    // ── Plan: sessions on a plan's issues (#125) ──
    /** `owner/repo#n` → the id of the session that owns it (S1), across the repository's sessions. */
    issueSessions(repository: string): Promise<Record<string, string>>;
    /**
     * Make the worktree a new session on a plan's issue starts in (A2, A3),
     * answering it and the prompt Claude starts with. The renderer starts the
     * session (`startIssueSession`), because the row is its to make.
     */
    prepareIssueWorktree(request: IssueWorktreeRequest): Promise<IssueWorktreeResult>;
    // ── Plans (#123) ──
    // Each answer is kept for 30 s in main, so polling is cheap. Null when `gh`
    // could not be asked, or the session or project is not a GitHub repository.
    /** The plans a session works on (W2, S1), and its repository's open plans as `others` (W3). */
    sessionPlans(sessionId: string): Promise<{plans: Plan[]; others: PlanSummary[]} | null>;
    /** One plan by its issue, for the Plan view without a session (F2). */
    plan(repo: string, number: number): Promise<Plan | null>;
    /** A project's plans for the picker (F1): open ones, and closed ones too with `closed` (F3). */
    projectPlans(projectPath: string, options: {closed: boolean}): Promise<PlanSummary[] | null>;
    // ── The project page (#172) ──
    /**
     * Everything the project page shows in one answer: its repository, grouped
     * plans, loose issues and PRs, worktrees and running sessions. The GitHub
     * part is kept for 30 s in main, and served stale when a refresh fails.
     * Closed plans and merged PRs only when asked; with `plans: false`, no
     * plans at all (`plansPending`), which answers in a fraction of the time.
     */
    projectOverview(projectPath: string, options?: ProjectOverviewOptions): Promise<ProjectOverview>;
    /**
     * Clean: remove the project's merged, clean, unlocked linked worktrees
     * with no session running in them, then prune. Never forced; branches are
     * kept. Nothing for an ssh project.
     */
    projectCleanWorktrees(projectPath: string): Promise<WorktreeCleanResult>;

    // ── The merge queue's buttons and errands (#315) ──
    // Nudge and a new Fix answer a first prompt; the renderer starts the session
    // (a row is its to make), then says which (`queueErrandStarted`) or that it
    // could not (`queueErrandAbandoned`). Those sessions are errands.
    /**
     * Nudge a held entry's reviewer, after the user said yes to `message`
     * (`nudgeMessage`) in a confirm: the first prompt of a session to start in
     * the project. Refused while a nudge for the same PR and reviewer stands.
     */
    queueNudge(request: NudgeRequest): Promise<NudgeResult>;
    /** The review request a nudge was about changed: the reviewer may be nudged again. */
    queueForgetNudge(repository: string, number: number, reviewer: string): Promise<void>;
    /** These PRs of the repository wait for these reviewers now: every other standing nudge in it is forgotten. */
    queueSettleNudges(repository: string, held: {number: number; reviewer: string}[]): Promise<void>;
    /** Fix in session: a worktree on the PR's branch and the first prompt of a new session there. */
    queueFix(request: FixRequest): Promise<FixResult>;
    /** Retry: remove `automerge:failed` from the PR. */
    queueRetry(repository: string, number: number): Promise<ErrandResult>;
    /** Opt in: add `automerge:opt-in` to the PR. */
    queueOptIn(repository: string, number: number): Promise<ErrandResult>;
    /** The errand's session started, as `sessionId`. */
    queueErrandStarted(errandId: string, sessionId: string): Promise<ErrandResult>;
    /** The errand's session could not be started: forget the errand (and its nudge). */
    queueErrandAbandoned(errandId: string): Promise<ErrandResult>;
    /** The repository's errands (every one without it), oldest first, with how far each got. */
    queueErrands(repository?: string): Promise<QueueErrandView[]>;
    /** The repository's running and queued jobs on self-hosted runners, by runner pool; asked while the section shows. */
    ciJobQueue(repository: string): Promise<CiJobQueueAnswer>;
    /**
     * Bump a queued job, after the user said yes to the runs it moves: those
     * runs are cancelled, and re-run once each stopped so they queue behind it.
     */
    ciJobBump(request: BumpRequest): Promise<BumpResult>;

    // ── Tasks: BlaakTasks in Switchboard (#248) ──
    // While no BlaakTasks URL is set, the BlaakTasks calls answer `{ kind: 'off' }`
    // and the link reads answer nothing; none of them reaches BlaakTasks.
    /** One list now: a view, or a search with `options.query`. Never rejects. */
    listTasks(query: TaskQuery): Promise<BlaakTasksResult<TaskRow[]>>;
    /** One task in full: its brief, progress log and Notion page. */
    getTask(taskId: string): Promise<BlaakTasksResult<TaskDetail>>;
    /** ★, snooze, or Done (only ever because you pressed for it; retried until it gets through). */
    updateTask(taskId: string, change: TaskChange): Promise<TaskUpdateResult>;
    /** Move the task to another repo by hand. */
    setTaskRepo(taskId: string, projectPath: string): Promise<IpcResult>;
    /**
     * The worktree and first prompt of a new session on a task: in `projectPath`,
     * else the task's repo, else the one Ask Patch picks. The renderer starts
     * the session (`startTaskSession`), because the row is its to make.
     */
    prepareTaskStart(request: TaskStartRequest): Promise<TaskStartPreparation>;
    /**
     * The session started from the task has started: link it (in `projectPath`,
     * the preparation's main checkout) and set the task In progress and ★.
     */
    taskSessionStarted(taskId: string, sessionId: string, projectPath: string): Promise<IpcResult>;
    /** "Link task…": the session works on this task now, replacing any it had. */
    linkSessionTask(sessionId: string, taskId: string): Promise<IpcResult>;
    /** The session no longer works on a task. */
    unlinkSessionTask(sessionId: string): Promise<IpcResult>;
    /** The id of the task the session works on, or null. */
    sessionTask(sessionId: string): Promise<string | null>;
    /** Every linked session's task id, by session id. */
    sessionTasks(): Promise<Record<string, string>>;
    /** A task's sessions, the most recently linked first, and the one that owns it. */
    taskSessions(taskId: string): Promise<TaskSessions>;
    /** The ids of the tasks whose repo is this project, the most recently linked first. */
    projectTasks(projectPath: string): Promise<string[]>;
    /**
     * A surface shows this list: it is pushed now and on every poll (about a
     * minute) as `onTasksChanged`, until `unwatchTasks`. Watching again under the
     * same id switches its list. A null query only keeps the poll (and the
     * retries of failed writes) running. Main polls only while something watches.
     */
    watchTasks(watchId: string, query: TaskQuery | null): Promise<void>;
    unwatchTasks(watchId: string): Promise<void>;

    // ── Fire-and-forget ──
    sendInput(id: string, data: string): void;
    resizeTerminal(id: string, cols: number, rows: number): void;
    closeTerminal(id: string): void;
    /** Close the Session work page: its watchers and polling stop. */
    closeSessionWork(sessionId: string): void;
    /** Move the window by hand from the sidebar's blank space (see `ElectronWindowDrag`). */
    startWindowDrag(): void;
    /** How far the pointer has come since the drag started, in screen points. */
    moveWindowDrag(dx: number, dy: number): void;
    endWindowDrag(): void;
    /** How many sessions are in the Blocked block; the dock bounces when it rises. */
    setNeedsInputCount(count: number): void;
    /**
     * The projects are loaded and the view restored: main may send what it held
     * for a window it opened (Quick Ask, R4).
     */
    rendererReady(): void;

    // ── Phone access (#194) ──
    getPhoneAccess(): Promise<PhoneAccessState>;
    /** Turn the listener on or off; answers the state it ended in. */
    setPhoneAccessEnabled(enabled: boolean): Promise<PhoneAccessState>;
    /** Make a fresh one-time code and show it as a QR code. */
    startPhonePairing(): Promise<PhoneAccessState>;
    stopPhonePairing(): Promise<PhoneAccessState>;
    /** The user's answer to "Pair 'Pixel 9 Pro'?". */
    confirmPhonePairing(requestId: string, accept: boolean): Promise<PhoneAccessState>;
    /** Un-pair one phone; its live connection drops at once. */
    revokePhoneDevice(deviceId: string): Promise<PhoneAccessState>;
    /** New Mac identity; every phone is un-paired. */
    resetPhoneIdentity(): Promise<PhoneAccessState>;
    /** Which device each running session's terminal is sized for; sessions not listed are the Mac's. */
    getTerminalOwners(): Promise<Record<string, TerminalOwner>>;
    /** Use here: make the Mac the active device for the session and resize it back. */
    useTerminalHere(sessionId: string): Promise<IpcResult>;

    // ── Settings → VMs: VMs registered on their own (#276, #307) ──
    /** The registered VMs, with each one's agent, link and projects. Never dials a VM. */
    vmHosts(): Promise<VmHostView[]>;
    /**
     * Register a VM by `user@host[:port]` and an optional name. Installs
     * nothing; refused (with the message to show) for a bad address or one
     * already registered. Its `key` names it in the other calls, and
     * `vmHostPath` of it is what the `agent*` calls below take.
     */
    addVmHost(input: {
        user: string;
        host: string;
        port?: number;
        name?: string;
    }): Promise<{ok: true; key: string} | {ok: false; error: string}>;
    /** Name a VM; an empty name goes back to `user@host`. False for an unknown key. */
    renameVmHost(key: string, name: string): Promise<boolean>;
    /** Forget a VM and its projects here; the agent and its sessions keep running on the VM. */
    removeVmHost(key: string): Promise<{ok: true} | {ok: false; error: string}>;
    /** The VM list changed: added, renamed, removed, an install finished, or a link came up or dropped. */
    onVmHostsChanged(cb: () => void): Unsubscribe;

    // ── VM hosts: the Switchboard agent (#276) ──
    // A host is named by any `ssh://` path on it: the VM's own (`vmHostPath`,
    // no folder) or a project's (`ssh://user@host[:port]/dir`).
    /** Whether the host has an agent, whether it is the app's version, and whether a link is open. */
    agentStatus(projectPath: string): Promise<AgentHostStatus>;
    /**
     * Install (or upgrade) the agent on the project's host. Its progress lines
     * arrive on `onAgentInstallProgress`; on success the project becomes a VM
     * project and `onProjectsChanged` fires.
     */
    installAgent(projectPath: string): Promise<AgentHostsResult>;
    /** The setup checks: each tool installed and signed in, and sudo. Null when the host can't be reached. */
    checkAgentTools(projectPath: string): Promise<{tools: ToolCheck[]; sudo: boolean} | null>;
    /** The host's settings, stored on the agent. Null when the host can't be reached. */
    agentHostSettings(projectPath: string): Promise<HostSettings | null>;
    /** Change some of the host's settings; answers all of them, or null when the host can't be reached. */
    setAgentHostSettings(projectPath: string, settings: Partial<HostSettings>): Promise<HostSettings | null>;
    /** Start the setup terminal on the host, answering its session id to open. */
    openAgentSetupTerminal(projectPath: string): Promise<{ok: true; sessionId: string} | {ok: false; error: string}>;

    // ── Project hand-off to a VM (#276 stage 2) ──
    /** The VM hosts a project can be handed off to; empty when there are none. */
    handoffHosts(): Promise<HandoffHost[]>;
    /** What handing a local project off would carry, or why it can't be handed off. */
    previewHandoff(localPath: string): Promise<HandoffPreview | {error: string}>;
    /**
     * Hand a local project off to a host, carrying the ticked ignored files and
     * the dialog's other choices (stage 5: whether the schedules move along).
     * Progress lines arrive on `onHandoffProgress`; on success the copy is a
     * project of its own and `onProjectsChanged` fires.
     */
    handOffProject(
        localPath: string,
        hostKey: string,
        ticked: string[],
        choices?: HandoffChoices,
    ): Promise<HandoffResult>;
    /**
     * A start the user handed off to a VM before it began (an issue's, a
     * task's, a level's): the worktrees it made go over as worktrees of the
     * project's copy, and with `project` the project's own copy is made when
     * the host has none. Progress lines arrive on `onHandoffProgress`.
     */
    handOffForStart(
        localPath: string,
        hostKey: string,
        worktrees: string[],
        options: {project: boolean},
    ): Promise<StartHandoffResult>;
    /** A local project's copies on VMs. */
    projectCopies(localPath: string): Promise<ProjectCopy[]>;
    /** The local project a copy was made from; null for a remote that isn't a copy. */
    copyOrigin(copyPath: string): Promise<string | null>;
    /** Where a copy stands on its VM; null when the VM can't be reached. */
    copyStatus(copyPath: string): Promise<CopyStatus | null>;
    /** Bring the copy's branch back into a new local worktree; progress on `onBringBackProgress`. */
    bringBackCopy(copyPath: string): Promise<BringBackResult>;
    /** Delete the copy on its VM and forget it; the local project is left alone. */
    removeCopy(copyPath: string): Promise<{ok: true} | {ok: false; error: string}>;

    // ── Session hand-off to a VM (#276 stage 3) ──
    /** What handing a session off would carry, or why it can't be handed off. */
    previewSessionHandoff(sessionId: string): Promise<SessionHandoffPreview | {error: string}>;
    /**
     * Hand a session off to a host, carrying the ticked ignored files. Answers
     * the last phase (done, failed or cancelled); every phase also arrives on
     * `onSessionHandoffPhase`. On done the same row continues on the VM.
     */
    handOffSession(sessionId: string, hostKey: string, ticked: string[]): Promise<SessionHandoffPhase>;
    /** Cancel a hand-off still waiting for its turn to end; false once it is running. */
    cancelSessionHandoff(sessionId: string): Promise<boolean>;

    // ── A VM session brought back to this Mac (#276) ──
    /** What bringing a VM session back would do, or why it can't be brought back. */
    previewSessionBringBack(sessionId: string): Promise<SessionBringBackPreview | {error: string}>;
    /**
     * Bring a VM session back: its branch into a local worktree, its
     * conversation resumed here in the same row. With the branch here already,
     * `existing` says what to do with it (`reuse` updates it, `replace` deletes
     * and recreates it); without, the answer is the `existing` phase. Every
     * phase also arrives on `onSessionBringBackPhase`.
     */
    bringBackSession(sessionId: string, existing?: ExistingBranchChoice): Promise<SessionBringBackPhase>;
    /** Cancel a Bring back still waiting for its turn to end; false once it is running. */
    cancelSessionBringBack(sessionId: string): Promise<boolean>;

    // ── Stage 5 (#276) ──
    /** Where a local project's (or its copy's) schedules run; null with neither schedules nor copies. */
    schedulesWhere(projectPath: string): Promise<ScheduleLocation | null>;
    /** Run a local project's schedules in that copy on its VM, or (null) back on the Mac. */
    runSchedulesOn(localPath: string, copyPath: string | null): Promise<ScheduleLocation | {error: string}>;
    /** Upload files dropped on a VM session's terminal; answers their paths on the VM, in order. */
    uploadDroppedFiles(
        sessionId: string,
        localPaths: string[],
    ): Promise<{ok: true; paths: string[]} | {ok: false; error: string}>;

    // ── Events from main ──
    // Each answers its unsubscribe, so a listener can be removed again (StrictMode
    // mounts twice; a hot reload re-installs the bridge).
    onTerminalData(cb: (sessionId: string, data: string) => void): Unsubscribe;
    onProcessExited(cb: (sessionId: string, exitCode: number) => void): Unsubscribe;
    onSessionForked(cb: (oldId: string, newId: string) => void): Unsubscribe;
    onCliBusyState(cb: (sessionId: string, busy: boolean) => void): Unsubscribe;
    onTerminalNotification(cb: (sessionId: string, message: string) => void): Unsubscribe;
    onSessionNeedsAttention(cb: (sessionId: string) => void): Unsubscribe;
    onSessionAgents(cb: (sessionId: string, agents: WorkingAgent[]) => void): Unsubscribe;
    onSessionBackgroundTasks(cb: (sessionId: string, tasks: BackgroundTask[]) => void): Unsubscribe;
    onRemoteStatus(cb: (sessionId: string, status: RemoteStatusPayload) => void): Unsubscribe;
    onQuestionsAsked(cb: (pending: PendingQuestions) => void): Unsubscribe;
    onQuestionsSettled(cb: (settled: QuestionsSettled) => void): Unsubscribe;
    /** A grilling round opened, changed (an answer, a revision, an ask) or closed. */
    onGrillChanged(cb: (changed: GrillChanged) => void): Unsubscribe;
    /** A session showed the user a page (`show_page`). */
    onPageShown(cb: (page: ShownPage) => void): Unsubscribe;
    onProjectsChanged(cb: () => void): Unsubscribe;
    onStatusUpdate(cb: (text: string, type: string) => void): Unsubscribe;
    onFullscreenChanged(cb: (isFullscreen: boolean) => void): Unsubscribe;
    onUpdateAvailable(cb: (update: UpdateNotice) => void): Unsubscribe;
    /** An install moved on a step, or its download moved on. */
    onUpdateProgress(cb: (progress: InstallProgress) => void): Unsubscribe;
    onSessionWorkSnapshot(cb: (snapshot: SessionWorkSnapshot) => void): Unsubscribe;
    /** A running session's PR chips changed colour (W4). */
    onPrStatusChanged(cb: (change: PullRequestStatusChange) => void): Unsubscribe;
    /** A repository's merge queue or its errands changed (#315). */
    onMergeQueueChanged(cb: (change: MergeQueueChange) => void): Unsubscribe;
    /** Quick Ask: start a Claude session there on this prompt (R3). */
    onLaunchRequested(cb: (projectPath: string, initialPrompt: string) => void): Unsubscribe;
    /** Quick Ask: open the New Session picker holding this prompt; `reason` is Patch's line. */
    onPickerRequested(cb: (initialPrompt: string, reason?: string) => void): Unsubscribe;
    /** Phone access changed: the setting, the listener, a device, the pairing code or a confirm request. */
    onPhoneAccessChanged(cb: (state: PhoneAccessState) => void): Unsubscribe;
    /** A session's terminal moved to another device, or back to the Mac. */
    onTerminalOwnerChanged(cb: (sessionId: string, owner: TerminalOwner) => void): Unsubscribe;
    /** Main started a Claude session on its own (a phone's Ask Patch): give it a row now. */
    onSessionStarted(cb: (sessionId: string, projectPath: string) => void): Unsubscribe;
    /** A phone archived a session: close it as archiving it here would. */
    onSessionArchived(cb: (sessionId: string) => void): Unsubscribe;
    /** A watched task list after a poll, or after a change: its rows, or that BlaakTasks is down, off or not set up. */
    onTasksChanged(cb: (update: TasksUpdate) => void): Unsubscribe;
    /** A session's task changed: a task id when it was linked, null when unlinked. */
    onSessionTaskChanged(cb: (sessionId: string, taskId: string | null) => void): Unsubscribe;
    /** The managers' inbox changed (#413): both managers' counts. */
    onInboxChanged(cb: (summary: InboxSummary) => void): Unsubscribe;
    /** The Merge manager's lanes changed (#434): every lane, and how many PRs need you. */
    onMergeManagerChanged(cb: (state: MergeManagerState) => void): Unsubscribe;
    /** One line of an agent install's progress, for the project whose host it is. */
    onAgentInstallProgress(cb: (projectPath: string, line: string) => void): Unsubscribe;
    /** One line of a hand-off's progress, for the local project being handed off. */
    onHandoffProgress(cb: (localPath: string, line: string) => void): Unsubscribe;
    /** One line of a Bring back's progress, for the copy it brings back from. */
    onBringBackProgress(cb: (copyPath: string, line: string) => void): Unsubscribe;
    /** Where a session's hand-off stands: waiting, a progress line, done, failed or cancelled. */
    onSessionHandoffPhase(cb: (sessionId: string, phase: SessionHandoffPhase) => void): Unsubscribe;
    /** Where a session's Bring back stands. */
    onSessionBringBackPhase(cb: (sessionId: string, phase: SessionBringBackPhase) => void): Unsubscribe;

    // ── Host facts the renderer needs synchronously ──
    /** The absolute path of a dropped File, for drag-and-drop into a terminal. */
    getPathForFile(file: File): string;
}
