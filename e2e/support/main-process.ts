/**
 * Reaching into the main process from a test, without a seam in the app.
 *
 * Playwright's `ElectronApplication.evaluate` runs a function in the main
 * process with the `electron` module as its argument. That is enough for two
 * things the harness needs:
 *
 * - **Host stubs.** A few IPC channels answer with facts about the machine the
 *   suite happens to run on (is sleep disabled right now? is there a newer
 *   release?) or act on it (open a browser, show a folder picker, replace the
 *   app, write the clipboard, prompt for an administrator password). Their
 *   handlers are swapped for test doubles, so a run is the same on every Mac
 *   and a stray click cannot reach the host.
 * - **Pushing events.** Anything main tells the renderer travels as a
 *   `webContents.send` on a channel from src/ipc/channels.ts, so a test can
 *   send one directly — a remote status, say — to put the UI in a state that
 *   would otherwise take a real network failure to reach.
 *
 * The channel names come from the app's own table, so a renamed channel breaks
 * the harness at compile time rather than leaving a stub silently unused.
 */
import type {ElectronApplication} from '@playwright/test';
import {EVENT, INVOKE, SEND} from '../../src/ipc/channels';
import type {SessionWorkDiff, SessionWorkSnapshot} from '../../src/domain/session-work/model';
import type {ActionRequest} from '../../src/domain/session-work/actions';
import type {PullRequestPeek} from '../../src/domain/session-work/pull-request-link';
import type {CommentRequest, ReviewRequest} from '../../src/domain/session-work/review';
import type {RemoteStatusPayload} from '../../src/domain/remote/remote-status';
import type {UpdateNotice} from '../../src/domain/update/release';
import type {InstallResult, UpdateOutcome} from '../../src/domain/update/progress';
import type {ErrandResult, FixResult, NudgeResult, QueueErrandView} from '../../src/domain/project/queue-errands';
import type {BumpResult, CiJobQueueAnswer} from '../../src/domain/project/ci-job-queue';
import type {Usage} from '../../src/domain/usage/usage';
import type {Weather, WeatherLocation} from '../../src/domain/weather/weather';
import type {Plan, PlanSummary} from '../../src/domain/plan/model';
import type {SessionPlans} from '../../src/application/services/plan-service';
import type {ProjectOverview} from '../../src/domain/project/overview';
import type {AgentHostStatus, AgentHostsResult} from '../../src/application/services/agent-hosts';
import type {HostSettings, ToolCheck} from '../../src/domain/agent/protocol';
import type {VmHostView} from '../../src/application/services/vm-registry';
import type {
    BringBackResult,
    CopyStatus,
    HandoffHost,
    HandoffPreview,
    HandoffChoices,
    HandoffResult,
    ProjectCopy,
} from '../../src/application/services/project-handoff';
import type {ScheduleLocation} from '../../src/application/services/vm-schedules';
import type {SessionHandoffPhase, SessionHandoffPreview} from '../../src/application/services/session-handoff';
import type {SessionBringBackPhase, SessionBringBackPreview} from '../../src/application/services/session-bring-back';

/**
 * The usage the gauges show unless a test says otherwise: fixed numbers, with
 * reset labels already formatted, so the footer looks the same on every run
 * without any credentials or network.
 */
export const STUB_USAGE: Usage = {
    limits: [
        {kind: 'session', label: 'Current session', model: null, percent: 42, reset: '6pm (UTC)', severity: 'normal'},
        {
            kind: 'weekly_all',
            label: 'Week (all models)',
            model: null,
            percent: 67,
            reset: 'Jun 12 at 9am (UTC)',
            severity: 'normal',
        },
    ],
};

export interface HostStubs {
    /** What `getUsage` answers; null hides the gauges. */
    usage: Usage | null;
    /** Make `getUsage` fail, as it does offline or without credentials. */
    usageFails: boolean;
    /** What `getUpdate` answers: the release main has found, or null for none. */
    update: UpdateNotice | null;
    /**
     * What `installUpdate` answers. 'pending' never answers, which is what the
     * renderer sees when an install works: the app quits from under it. Its
     * progress is pushed with `pushEvent(app, EVENT.updateProgress, …)`.
     */
    installUpdate: InstallResult | 'pending';
    /** What `getUpdateOutcome` answers: how the install before this launch went. */
    updateOutcome: UpdateOutcome | null;
    /** Whether `pmset` would report sleep as disabled; null is a host that cannot say. */
    sleepDisabled: boolean | null;
    /**
     * How long the sleep switch takes to answer, standing in for the password
     * prompt the real one may show.
     */
    sleepPromptDelayMs: number;
    /** True when that prompt is cancelled: the switch answers with the state unchanged. */
    sleepPromptCancelled: boolean;
    /** What the folder picker "chooses"; null is a cancelled dialog. */
    browseFolder: string | null;
    /**
     * What `getWeather` answers: null is no sky (weather switched off, or not
     * fetched), and `'never'` a fetch that never comes back, for the timeouts
     * that guard it.
     */
    weather: Weather | null | 'never';
    /**
     * What looking up a weather city answers, by the name typed: a location
     * (after `delayMs`, to hold a lookup in flight), null for "no such place",
     * or 'fail' for a lookup that throws. A name not listed finds nothing.
     */
    geocode: Record<string, GeocodeStub>;
    /**
     * The Session work page's back end, standing in for git and `gh`; null
     * leaves the real service, which finds no repository in the fixture home.
     */
    sessionWork: SessionWorkStub | null;
    /**
     * The Plan tab's back end, standing in for `gh`; null leaves the real
     * service, which finds no repository in the fixture home.
     */
    plans: PlansStub | null;
    /**
     * What `projectOverview` answers, standing in for git and `gh`, by the end of
     * the project's path (`Development/acme-api`); null leaves the real service,
     * which finds no repository in the fixture home. A project not listed has no
     * GitHub remote. Closed plans and merged PRs are left out unless asked for, all plans when
     * asked without them (`plans: false`), and an answered GitHub part is dated the moment it is asked.
     * Clean takes the answer's superfluous worktrees out of it.
     */
    projectOverview: Record<string, ProjectOverview> | null;
    /**
     * The merge queue's buttons and errands (#315), standing in for `gh` and
     * the errand store: every `queue:*` channel answers from here, and each
     * call is recorded (see `mergeQueueRequests`). Null leaves the real
     * handlers, which reach `gh`.
     */
    mergeQueue: MergeQueueStub | null;
    /**
     * The VM hosts' back end (#276), standing in for the agent and the ssh it
     * is reached over: every `agent:*` channel answers from here, so no test
     * can dial a host. Each request is recorded (see `agentRequests`).
     */
    agent: AgentStub;
    /**
     * Settings → VMs' registry (#307), kept in memory in place of the one in
     * settings; null (the default) leaves the real `vm-registry:*` handlers,
     * which touch no host: the fixture's agent remotes are registered by the
     * migration on first read, and a VM's `connected` is read without dialling.
     *
     * Needed only where the real one can't follow: a stubbed install never
     * records its agent there. Here a successful `agent:install` gives its VM
     * the version `agent.status` names, and each change pushes
     * `vm-registry:changed`, as main does. A VM's `projects` stay as given.
     */
    vmRegistry: VmRegistryStub | null;
    /**
     * Project hand-off's back end (#276 stage 2), standing in for the ssh and
     * git a hand-off, a Bring back and a removal run against a VM: every
     * `handoff:*` channel answers from here, so no test can reach a VM. Each
     * request is recorded (see `handoffRequests`). The default has no hosts,
     * as the standard fixture has no VM, so a local project page shows no
     * Hand off to…; `STUB_HANDOFF` has one.
     */
    handoff: HandoffStub;
    /**
     * Session hand-off's back end (#276 stage 3), standing in for the ssh and
     * git that move a running session to a VM: every `session-handoff:*`
     * channel answers from here, so no test can reach a VM. Each request is
     * recorded (see `sessionHandoffRequests`). Hand off to… on a row shows
     * only once `handoff` has hosts, so the default is never reached.
     */
    sessionHandoff: SessionHandoffStub;
    /**
     * A VM session brought back to this Mac (#276), standing in for the agent
     * and the git that move it: every `session-bring-back:*` channel answers
     * from here, so no test can reach a VM. Each request is recorded (see
     * `sessionBringBackRequests`).
     */
    sessionBringBack: SessionBringBackStub;
    /**
     * Where schedules run (#276 stage 5), standing in for the agent a move
     * tells: every `vm-schedules:*` channel answers from here, so no test can
     * reach a VM. Each request is recorded (see `vmSchedulesRequests`). The
     * default knows of no schedules, so no page shows a Schedules line and the
     * hand-off dialog no checkbox.
     */
    vmSchedules: VmSchedulesStub;
    /**
     * Files dropped on a VM session's terminal (#276 stage 5), standing in for
     * the upload over ssh: `dropped-files:to-session` answers from here. Each
     * request is recorded (see `droppedFilesRequests`). The default answers an
     * error, so nothing is typed.
     */
    droppedFiles: DroppedFilesStub;
    /**
     * What the peek a PR link opens answers, by `owner/repo#N`, standing in for
     * `gh`. A PR not listed answers as one GitHub does not know. Each request is
     * recorded (see `peekedPullRequests`).
     */
    pullRequestPeeks: Record<string, PullRequestPeek>;
}

/** What the `queue:*` channels answer. */
export interface MergeQueueStub {
    /** What the CI job queue under the section answers, and a Bump. */
    ciJobs: CiJobQueueAnswer;
    bump: BumpResult;
    errands: QueueErrandView[];
    nudge: NudgeResult;
    fix: FixResult;
    retry: ErrandResult;
    optIn: ErrandResult;
}

/** One call the renderer made on a `queue:*` channel: its method on `window.api`, and its arguments. */
export interface MergeQueueRequest {
    call: string;
    args: unknown[];
}

/** What the `vm-schedules:*` channels answer. */
export interface VmSchedulesStub {
    /** What `where` answers, by the project's path (a local one's absolute path, or a copy's); a path not here answers null. */
    where: Record<string, ScheduleLocation>;
    /** What `runOn` answers: the new location, or why the VM couldn't be told. */
    runOn: ScheduleLocation | {error: string};
}

/** What the renderer asked the `vm-schedules:*` stubs, in order. */
export interface VmSchedulesRequests {
    where: string[];
    runOn: {localPath: string; copyPath: string | null}[];
}

/** What `dropped-files:to-session` answers, for every session alike. */
export interface DroppedFilesStub {
    result: {ok: true; paths: string[]} | {ok: false; error: string};
    /** How long the upload takes to answer, so its note can be seen. */
    delayMs?: number;
}

/** One upload the renderer asked for. */
export interface DroppedFilesRequest {
    sessionId: string;
    localPaths: string[];
}

/** What the `session-handoff:*` channels answer. */
export interface SessionHandoffStub {
    /** What the dialog's preview answers, for every session alike. */
    preview: SessionHandoffPreview | {error: string};
    /**
     * The phases Hand off pushes on `session-handoff:phase`, one at a time,
     * `phaseDelayMs` apart; it answers the last one. On `done` it also tells
     * the window the session started on the copy and the projects changed, as
     * the real handler does.
     */
    phases: SessionHandoffPhase[];
    phaseDelayMs: number;
    /**
     * How long a `waiting` phase holds before the next one comes, standing in
     * for the turn that has to end. Cancel meanwhile ends the hand-off
     * `cancelled`, and nothing after it is pushed.
     */
    waitingMs: number;
}

/** What the `session-bring-back:*` channels answer. */
export interface SessionBringBackStub {
    preview: SessionBringBackPreview | {error: string};
    /**
     * The phases Bring back pushes on `session-bring-back:phase`, by the choice
     * it was called with (`none` without one), `phaseDelayMs` apart; it
     * answers the last one.
     */
    phases: Record<'none' | 'reuse' | 'replace', SessionBringBackPhase[]>;
    phaseDelayMs: number;
}

/** What the renderer asked the `session-bring-back:*` stubs, in order. */
export interface SessionBringBackRequests {
    preview: string[];
    bringBack: {sessionId: string; existing: string | null}[];
}

/** Where the e2e Bring back lands: the hand-off's worktree of acme-api, left behind on this Mac. */
export const STUB_BRING_BACK_WORKTREE = '/nowhere/acme-api/.claude/worktrees/session-cookie';

/**
 * A session on the acme-api copy whose branch is on this Mac already, in the
 * worktree its hand-off left; each choice runs two steps and continues here.
 */
export const STUB_SESSION_BRING_BACK: SessionBringBackStub = {
    preview: {
        copyPath: 'ssh://joris@devbox.local/~/projects/acme-api',
        localPath: '/nowhere/acme-api',
        branch: 'session-cookie',
        worktree: STUB_BRING_BACK_WORKTREE,
        existing: {
            branch: 'session-cookie',
            worktreePath: STUB_BRING_BACK_WORKTREE,
            main: false,
            changedFiles: 1,
            ahead: 2,
            sessionId: null,
        },
        busy: false,
    },
    phases: {
        none: [{kind: 'failed', error: 'The stub wants a choice'}],
        reuse: [
            {kind: 'running', line: 'Fetching session-cookie from the VM'},
            {kind: 'running', line: 'Carrying the conversation back'},
            {kind: 'done', projectPath: STUB_BRING_BACK_WORKTREE},
        ],
        replace: [
            {kind: 'running', line: `Deleting the worktree at ${STUB_BRING_BACK_WORKTREE}`},
            {kind: 'running', line: 'Carrying the conversation back'},
            {kind: 'done', projectPath: STUB_BRING_BACK_WORKTREE},
        ],
    },
    phaseDelayMs: 0,
};

/** What the renderer asked the `session-handoff:*` stubs, in order. */
export interface SessionHandoffRequests {
    preview: string[];
    handOff: {sessionId: string; hostKey: string; ticked: string[]}[];
    cancel: string[];
}

/**
 * A busy session in the `session-cookie` worktree of acme-api on its own
 * branch, with work only this Mac has and the two ignored config files of
 * `STUB_HANDOFF`.
 */
export const STUB_SESSION_PREVIEW: SessionHandoffPreview = {
    localPath: '/nowhere/acme-api',
    worktree: 'session-cookie',
    branch: 'session-cookie',
    unpushed: 2,
    uncommitted: 1,
    candidates: [
        {path: '.env', size: 312, ticked: true},
        {path: '.env.local', size: 4200, ticked: false},
    ],
    busy: true,
};

/**
 * `STUB_SESSION_PREVIEW`, and a hand-off that waits for the turn, runs two
 * steps and continues on the copy of `handoffFixture`.
 */
export const STUB_SESSION_HANDOFF: SessionHandoffStub = {
    preview: STUB_SESSION_PREVIEW,
    phases: [
        {kind: 'waiting'},
        {kind: 'running', line: 'Handing off the checkout…'},
        {kind: 'running', line: 'Copying the transcript…'},
        {kind: 'done', copyPath: 'ssh://joris@devbox.local/~/projects/acme-api'},
    ],
    phaseDelayMs: 0,
    waitingMs: 0,
};

/** What the `handoff:*` channels answer. */
export interface HandoffStub {
    /** What `handoffHosts` answers: the VM hosts a local project can be handed off to. */
    hosts: HandoffHost[];
    /** What the dialog's preview answers, for every local project alike. */
    preview: HandoffPreview | {error: string};
    /** The progress lines Hand off pushes, one at a time, before it answers. */
    lines: string[];
    /** How long each progress line (Hand off's and Bring back's) takes to arrive. */
    lineDelayMs: number;
    /** What Hand off answers once its lines are out. */
    result: HandoffResult;
    /** A local project's copies, by its absolute path; a project not here has none. */
    copies: Record<string, ProjectCopy[]>;
    /** A copy's local project, by the copy's path; a remote not here isn't a copy. */
    origins: Record<string, string>;
    /** Where every copy stands; null is a VM that can't be reached. */
    copyStatus: CopyStatus | null;
    /** The progress lines Bring back pushes before it answers. */
    bringBackLines: string[];
    bringBackResult: BringBackResult;
    removeResult: {ok: true} | {ok: false; error: string};
}

/** What the renderer asked the `handoff:*` stubs, in order. */
export interface HandoffRequests {
    preview: string[];
    handOff: {localPath: string; hostKey: string; ticked: string[]; choices: HandoffChoices}[];
    copyStatus: string[];
    bringBack: string[];
    removeCopy: string[];
}

/** The VM host of `vmFixture`, as hand-off names it. */
export const STUB_HANDOFF_HOST: HandoffHost = {key: 'joris@devbox.local:22', label: 'joris@devbox.local'};

/**
 * One VM host; a project on `main` with work only this Mac has and two
 * ignored config files, the first ticked; a hand-off that makes a new copy,
 * a clean copy, and a Bring back and a removal that work.
 */
export const STUB_HANDOFF: HandoffStub = {
    hosts: [STUB_HANDOFF_HOST],
    preview: {
        branch: 'main',
        unpushed: 2,
        uncommitted: 1,
        candidates: [
            {path: '.env', size: 312, ticked: true},
            {path: '.env.local', size: 4200, ticked: false},
        ],
        existing: {},
    },
    lines: [],
    lineDelayMs: 0,
    result: {ok: true, copyPath: 'ssh://joris@devbox.local/~/projects/acme-api', reused: false},
    copies: {},
    origins: {},
    copyStatus: {branch: 'main', unpushed: [], uncommitted: []},
    bringBackLines: [],
    bringBackResult: {ok: true, worktree: '/nowhere/acme-api/.claude/worktrees/from-vm', branch: 'from-vm'},
    removeResult: {ok: true},
};

/** What the `vm-registry:*` channels answer, while stubbed. */
export interface VmRegistryStub {
    /** The registered VMs, in order; Add a VM appends one with no agent yet. */
    hosts: VmHostView[];
}

/** A registered VM as `vm-registry:list` answers it: no name, no agent yet, no projects. */
export function stubVmHost(user: string, host: string, port = 22, change: Partial<VmHostView> = {}): VmHostView {
    return {
        key: `${user}@${host}:${port}`,
        user,
        host,
        port,
        label: `${user}@${host}${port === 22 ? '' : ':' + port}`,
        agent: null,
        current: false,
        connected: false,
        projects: [],
        ...change,
    };
}

/** What the `agent:*` channels answer, for every host alike. */
export interface AgentStub {
    /** What `agentStatus` answers. */
    status: AgentHostStatus;
    /** The progress lines Install agent pushes, one at a time, before it answers. */
    installLines: string[];
    /** How long each progress line takes to arrive, so the running install can be seen. */
    installLineDelayMs: number;
    /** What Install agent answers once its lines are out. */
    installResult: AgentHostsResult;
    /** What the setup checks answer; null is a VM that can't be reached. */
    tools: {tools: ToolCheck[]; sudo: boolean} | null;
    /**
     * The host settings on the agent, kept in memory: a change is merged in and
     * the result answered. Null is a VM that can't be reached, for both.
     */
    hostSettings: HostSettings | null;
    /** What Open setup terminal answers. */
    setupTerminal: {ok: true; sessionId: string} | {ok: false; error: string};
}

/** What the renderer asked the `agent:*` stubs, by project path, in order. */
export interface AgentRequests {
    install: string[];
    setHostSettings: {projectPath: string; change: Partial<HostSettings>}[];
    openSetupTerminal: string[];
}

/** A VM where the agent is installed and answers, with every tool ready. */
export const STUB_AGENT: AgentStub = {
    status: {installed: '0.0.0-e2e', current: true, connected: true},
    installLines: [],
    installLineDelayMs: 0,
    installResult: {ok: true},
    tools: {
        tools: [
            {tool: 'claude', installed: true, version: '2.1.0', loggedIn: true},
            {tool: 'gh', installed: true, version: '2.60.1', loggedIn: true},
            {tool: 'git', installed: true, version: '2.43.0'},
        ],
        sudo: true,
    },
    hostSettings: {instructions: 'You are on a self-contained Linux VM.', copyConfig: false, baseFolder: '~/projects'},
    setupTerminal: {ok: false, error: 'No setup terminal in the harness'},
};

/** What the plan channels answer: a session's plans, one plan by its issue, and the sessions that own issues. */
export interface PlansStub {
    /** By session id; a session not here answers null, as one outside a repository does. */
    sessionPlans: Record<string, SessionPlans>;
    /** By `owner/repo#n`. */
    plans?: Record<string, Plan>;
    /** By repository: `owner/repo#n` → the session that owns it. */
    issueSessions?: Record<string, Record<string, string>>;
    /**
     * A project's plans for the picker, by the end of its path (`Development/acme-api`):
     * open and closed together, as `projectPlans` with `closed` answers them. A project
     * not here has none; null answers as a project with no GitHub remote does.
     */
    projectPlans?: Record<string, PlanSummary[] | null>;
    /**
     * Answer Start session's worktree request without git: a worktree named
     * after the issue under the project's `.claude/worktrees/`, never made on
     * disk. Unset, the real service answers (and needs a GitHub repository).
     */
    prepareWorktrees?: boolean;
    /**
     * With `prepareWorktrees`: the issues whose branch exists already. Asked
     * without `existing`, one answers the refusal, naming `session` as the one
     * that worked on it; with `reuse` it answers the continue prompt, and with
     * `replace` a fresh start. Every request's `existing` is kept, in order, on
     * `globalThis.__existingAsked` in main.
     */
    existingBranches?: {issues: number[]; session: string | null};
}

/**
 * Which sessions the page can open for, and the snapshot it opens with. A
 * session with no snapshot opens on the skeleton and stays there.
 */
export interface SessionWorkStub {
    canOpen: string[];
    snapshots: Record<string, SessionWorkSnapshot>;
    /** What `getSessionWorkDiff` answers, by item id: an item not here has no changes, and 'never' never answers. */
    diffs?: Record<string, SessionWorkDiff | 'never'>;
    /**
     * Why every action is refused; unset queues each one, answering `act-<n>`.
     * Either way the request is recorded (see `sessionWorkActions`).
     */
    refuseActions?: string;
    /** Why every review write (a comment, submit, discard) is refused; unset, each one goes through. */
    refuseReview?: string;
    /** What the Checks panel's log request answers, by check run URL; a URL not here has no log. */
    checkLogs?: Record<string, string>;
    /**
     * What `sessionWorkImage` answers, by `imageStubKey`, as base64: the bytes
     * the real service would read for that side. A side not here has none.
     */
    images?: Record<string, string>;
}

/** Where `SessionWorkStub.images` files one side of an image in an item's diff. */
export function imageStubKey(itemId: string, path: string, side: 'before' | 'after'): string {
    return [itemId, path, side].join('\n');
}

export type GeocodeStub = {location: WeatherLocation | null; delayMs?: number} | 'fail';

/**
 * What the stubs keep in the main process, on `globalThis.__switchboardE2E`.
 * Evaluated functions are serialised into main, so they reach it through this
 * global rather than through a closure.
 */
interface StubState extends HostStubs {
    opened: string[];
    calls: HostStubCalls;
    clipboard: string[];
    /** Every image written to the clipboard, as base64 PNG. */
    clipboardImages: string[];
    /** Every session the renderer told main its Session work page closed for, in order. */
    sessionWorkClosed: string[];
    /** Every action the page asked main for, in order. */
    sessionWorkActions: ActionRequest[];
    /** Every queued action the page asked main to cancel, by id. */
    sessionWorkCancels: string[];
    /** Every call on a `queue:*` channel, in order. */
    mergeQueueRequests: MergeQueueRequest[];
    /** Every write to your review the page asked main for, in order. */
    sessionWorkReviews: ReviewWrite[];
    /** What the renderer asked the agent stubs. */
    agentRequests: AgentRequests;
    /** What the renderer asked the hand-off stubs. */
    handoffRequests: HandoffRequests;
    /** What the renderer asked the session hand-off stubs. */
    sessionHandoffRequests: SessionHandoffRequests;
    /** What the renderer asked the session Bring back stubs. */
    sessionBringBackRequests: SessionBringBackRequests;
    /** What the renderer asked the schedules stubs. */
    vmSchedulesRequests: VmSchedulesRequests;
    /** Every upload of dropped files the renderer asked for, in order. */
    droppedFilesRequests: DroppedFilesRequest[];
    /** Everything the renderer sent a terminal as input, in order. */
    terminalInputs: TerminalInput[];
    /** Every PR the peek asked main for, as `owner/repo#N`, in order. */
    peeked: string[];
}

/** One `sendInput`: what the renderer typed into a session's terminal. */
export interface TerminalInput {
    sessionId: string;
    data: string;
}

/** A comment added to the pending review, or the review finished. */
export type ReviewWrite = {comment: CommentRequest} | {review: ReviewRequest};

/** How often the renderer asked the stubs for something, by channel. */
export interface HostStubCalls {
    getUsage: number;
    installUpdate: number;
    getWeather: number;
}

type WithStubs = typeof globalThis & {__switchboardE2E: StubState};

export const DEFAULT_STUBS: HostStubs = {
    usage: STUB_USAGE,
    usageFails: false,
    update: null,
    installUpdate: 'pending',
    updateOutcome: null,
    sleepDisabled: false,
    sleepPromptDelayMs: 0,
    sleepPromptCancelled: false,
    browseFolder: null,
    weather: null,
    geocode: {},
    sessionWork: null,
    plans: null,
    projectOverview: null,
    mergeQueue: null,
    agent: STUB_AGENT,
    vmRegistry: null,
    handoff: {...STUB_HANDOFF, hosts: []},
    sessionHandoff: STUB_SESSION_HANDOFF,
    sessionBringBack: STUB_SESSION_BRING_BACK,
    vmSchedules: {where: {}, runOn: {error: 'No VM in the harness'}},
    droppedFiles: {result: {ok: false, error: 'No VM in the harness'}},
    pullRequestPeeks: {},
};

/** Replace the host-facing IPC handlers. Call before the renderer (re)loads. */
export async function installHostStubs(app: ElectronApplication, stubs: HostStubs): Promise<void> {
    await app.evaluate(
        ({ipcMain}, {stubs, channels, send, events}) => {
            const state: StubState = {
                ...stubs,
                opened: [],
                calls: {getUsage: 0, installUpdate: 0, getWeather: 0},
                clipboard: [],
                clipboardImages: [],
                sessionWorkClosed: [],
                sessionWorkActions: [],
                sessionWorkCancels: [],
                mergeQueueRequests: [],
                sessionWorkReviews: [],
                agentRequests: {install: [], setHostSettings: [], openSetupTerminal: []},
                handoffRequests: {preview: [], handOff: [], copyStatus: [], bringBack: [], removeCopy: []},
                sessionHandoffRequests: {preview: [], handOff: [], cancel: []},
                sessionBringBackRequests: {preview: [], bringBack: []},
                vmSchedulesRequests: {where: [], runOn: []},
                droppedFilesRequests: [],
                terminalInputs: [],
                peeked: [],
            };
            (globalThis as WithStubs).__switchboardE2E = state;

            // Heard beside the real handler, which writes it to the session's PTY (if it has one).
            ipcMain.on(send.terminalInput, (_event, sessionId, data) => {
                state.terminalInputs.push({sessionId: String(sessionId), data: String(data)});
            });

            // Heard beside the real handler, which ignores a close for a page it never opened.
            ipcMain.on(send.sessionWorkClose, (_event, sessionId) => {
                state.sessionWorkClosed.push(String(sessionId));
            });
            if (state.sessionWork) {
                const work = state.sessionWork;
                ipcMain.removeHandler(channels.sessionWorkCanOpen);
                ipcMain.handle(channels.sessionWorkCanOpen, (_event, sessionId) =>
                    work.canOpen.includes(String(sessionId)),
                );
                ipcMain.removeHandler(channels.sessionWorkOpen);
                ipcMain.handle(channels.sessionWorkOpen, (_event, sessionId) => {
                    const snapshot = work.snapshots[String(sessionId)];
                    // No snapshot: main is still reading git, and the page stays a skeleton.
                    return snapshot ?? new Promise(() => {});
                });
                ipcMain.removeHandler(channels.sessionWorkDiff);
                ipcMain.handle(channels.sessionWorkDiff, (_event, request: {itemId: string}) => {
                    const diff = work.diffs?.[String(request?.itemId)];
                    if (diff === 'never') return new Promise(() => {});
                    return diff ?? {files: [], source: null};
                });
                // The page's actions would type into the session through the real queue,
                // which needs the real page; recorded here instead, and the test pushes
                // the snapshot that shows what the queue would have done.
                ipcMain.removeHandler(channels.sessionWorkAction);
                ipcMain.handle(channels.sessionWorkAction, (_event, request: ActionRequest) => {
                    state.sessionWorkActions.push(request);
                    if (work.refuseActions) return {ok: false, reason: work.refuseActions};
                    return {ok: true, activityId: 'act-' + state.sessionWorkActions.length};
                });
                ipcMain.removeHandler(channels.sessionWorkCancel);
                ipcMain.handle(channels.sessionWorkCancel, (_event, activityId) => {
                    state.sessionWorkCancels.push(String(activityId));
                    return {ok: true};
                });
                // Your review would be written to GitHub; recorded here instead.
                ipcMain.removeHandler(channels.sessionWorkComment);
                ipcMain.handle(channels.sessionWorkComment, (_event, request: CommentRequest) => {
                    state.sessionWorkReviews.push({comment: request});
                    return work.refuseReview ? {ok: false, reason: work.refuseReview} : {ok: true};
                });
                ipcMain.removeHandler(channels.sessionWorkReview);
                ipcMain.handle(channels.sessionWorkReview, (_event, request: ReviewRequest) => {
                    state.sessionWorkReviews.push({review: request});
                    return work.refuseReview ? {ok: false, reason: work.refuseReview} : {ok: true};
                });
                // The real one would ask `gh` for the log.
                ipcMain.removeHandler(channels.sessionWorkCheckLog);
                ipcMain.handle(
                    channels.sessionWorkCheckLog,
                    (_event, request: {checkRunUrl: string}) => work.checkLogs?.[String(request?.checkRunUrl)] ?? null,
                );
                // The real one reads the bytes at the commits the diff was made from.
                ipcMain.removeHandler(channels.sessionWorkImage);
                ipcMain.handle(
                    channels.sessionWorkImage,
                    (_event, request: {itemId: string; path: string; side: string}) => {
                        const bytes = work.images?.[[request?.itemId, request?.path, request?.side].join('\n')];
                        return bytes ? new Uint8Array(Buffer.from(bytes, 'base64')) : null;
                    },
                );
            }

            if (state.plans) {
                const plans = state.plans;
                // Read at each call, so `setHostStub(app, 'plans', …)` changes what the next poll answers.
                const now = (): PlansStub => state.plans ?? plans;
                ipcMain.removeHandler(channels.planSessionPlans);
                ipcMain.handle(
                    channels.planSessionPlans,
                    (_event, sessionId) => now().sessionPlans[String(sessionId)] ?? null,
                );
                ipcMain.removeHandler(channels.planGet);
                ipcMain.handle(
                    channels.planGet,
                    (_event, repo, number) => now().plans?.[String(repo) + '#' + String(number)] ?? null,
                );
                ipcMain.removeHandler(channels.planProjectPlans);
                ipcMain.handle(
                    channels.planProjectPlans,
                    (_event, projectPath, options: {closed?: boolean} | undefined) => {
                        const found = Object.entries(plans.projectPlans ?? {}).find(([end]) =>
                            String(projectPath).endsWith('/' + end),
                        );
                        if (!found) return [];
                        if (!found[1]) return null;
                        return options?.closed ? found[1] : found[1].filter((plan) => plan.state === 'open');
                    },
                );
                ipcMain.removeHandler(channels.planIssueSessions);
                ipcMain.handle(channels.planIssueSessions, (_event, repo) => plans.issueSessions?.[String(repo)] ?? {});
                if (plans.prepareWorktrees) {
                    ipcMain.removeHandler(channels.planPrepareIssueWorktree);
                    ipcMain.handle(
                        channels.planPrepareIssueWorktree,
                        (
                            _event,
                            request: {
                                projectPath: string;
                                issue: {number: number};
                                existing?: 'replace' | 'reuse';
                            },
                        ) => {
                            const branch = request.issue.number + '-issue';
                            const worktreePath = request.projectPath + '/.claude/worktrees/' + branch;
                            const exists = plans.existingBranches?.issues.includes(request.issue.number);
                            if (exists) {
                                const asked = ((globalThis as {__existingAsked?: (string | null)[]}).__existingAsked ??=
                                    []);
                                asked.push(request.existing ?? null);
                            }
                            if (exists && !request.existing) {
                                return {
                                    ok: false,
                                    reason: `Branch ${branch} already exists`,
                                    existing: {
                                        branch,
                                        worktreePath,
                                        main: false,
                                        changedFiles: 2,
                                        ahead: 1,
                                        sessionId: plans.existingBranches!.session,
                                    },
                                };
                            }
                            const prompt =
                                (request.existing === 'reuse' ? 'Continue work on #' : 'Work on #') +
                                request.issue.number +
                                '.';
                            return {ok: true, worktreePath, branch, prompt};
                        },
                    );
                }
            }

            if (state.projectOverview) {
                // Read at each call, so `setHostStub(app, 'projectOverview', …)` changes what the next poll answers.
                ipcMain.removeHandler(channels.projectOverview);
                ipcMain.handle(
                    channels.projectOverview,
                    (
                        _event,
                        projectPath,
                        options: {closed?: boolean; merged?: boolean; plans?: boolean} | undefined,
                    ) => {
                        const path = String(projectPath);
                        const found = Object.entries(state.projectOverview ?? {}).find(([end]) =>
                            path.endsWith('/' + end),
                        );
                        if (!found)
                            return {
                                projectPath: path,
                                remote: false,
                                repository: null,
                                github: null,
                                worktrees: [],
                                running: [],
                            };
                        const overview = found[1];
                        const github = overview.github?.ok
                            ? {
                                  ...overview.github,
                                  fetchedAt: Date.now(),
                                  // Asked without plans, as the page asks first: none, and pending.
                                  plansPending: options?.plans === false,
                                  plans:
                                      options?.plans === false
                                          ? []
                                          : options?.closed
                                            ? overview.github.plans
                                            : overview.github.plans.filter((plan) => plan.state === 'open'),
                                  pullRequests: options?.merged
                                      ? overview.github.pullRequests
                                      : overview.github.pullRequests.filter(
                                            (row) => row.pullRequest.state !== 'merged',
                                        ),
                              }
                            : overview.github;
                        return {...overview, projectPath: path, github};
                    },
                );
                // Clean takes the superfluous worktrees out of the stubbed answer, so the next poll lists them gone.
                ipcMain.removeHandler(channels.projectCleanWorktrees);
                ipcMain.handle(channels.projectCleanWorktrees, (_event, projectPath) => {
                    const path = String(projectPath);
                    const found = Object.entries(state.projectOverview ?? {}).find(([end]) => path.endsWith('/' + end));
                    if (!found) return {removed: [], failed: []};
                    const [end, overview] = found;
                    const superfluous = (worktree: ProjectOverview['worktrees'][number]): boolean =>
                        !worktree.main &&
                        !worktree.locked &&
                        worktree.changedFiles === 0 &&
                        worktree.merged &&
                        worktree.running.length === 0;
                    state.projectOverview = {
                        ...state.projectOverview,
                        [end]: {...overview, worktrees: overview.worktrees.filter((w) => !superfluous(w))},
                    };
                    return {removed: overview.worktrees.filter(superfluous).map((w) => w.path), failed: []};
                });
            }

            const replace = (channel: string, handler: (...args: unknown[]) => unknown): void => {
                ipcMain.removeHandler(channel);
                ipcMain.handle(channel, (_event, ...args) => handler(...args));
            };

            if (state.mergeQueue) {
                // Read at each call, so `setHostStub(app, 'mergeQueue', …)` changes the next answer.
                const queue =
                    (call: string, answer: (stub: MergeQueueStub) => unknown) =>
                    (...args: unknown[]) => {
                        state.mergeQueueRequests.push({call, args});
                        return state.mergeQueue ? answer(state.mergeQueue) : undefined;
                    };
                replace(
                    channels.queueNudge,
                    queue('queueNudge', (stub) => stub.nudge),
                );
                replace(
                    channels.queueForgetNudge,
                    queue('queueForgetNudge', () => undefined),
                );
                replace(
                    channels.queueSettleNudges,
                    queue('queueSettleNudges', () => undefined),
                );
                replace(
                    channels.queueFix,
                    queue('queueFix', (stub) => stub.fix),
                );
                replace(
                    channels.queueRetry,
                    queue('queueRetry', (stub) => stub.retry),
                );
                replace(
                    channels.queueOptIn,
                    queue('queueOptIn', (stub) => stub.optIn),
                );
                replace(
                    channels.queueErrandStarted,
                    queue('queueErrandStarted', () => ({ok: true})),
                );
                replace(
                    channels.queueErrandAbandoned,
                    queue('queueErrandAbandoned', () => ({ok: true})),
                );
                replace(
                    channels.queueErrands,
                    queue('queueErrands', (stub) => stub.errands),
                );
                replace(
                    channels.ciJobQueue,
                    queue('ciJobQueue', (stub) => stub.ciJobs),
                );
                replace(
                    channels.ciJobBump,
                    queue('ciJobBump', (stub) => stub.bump),
                );
            }

            replace(channels.getUsage, () => {
                state.calls.getUsage++;
                if (state.usageFails) throw new Error('usage unavailable');
                return state.usage;
            });
            replace(channels.getUpdate, () => state.update);
            replace(channels.getUpdateOutcome, () => state.updateOutcome);
            replace(channels.installUpdate, () => {
                state.calls.installUpdate++;
                return state.installUpdate === 'pending' ? new Promise(() => {}) : state.installUpdate;
            });
            replace(channels.getSleepDisabled, () => state.sleepDisabled);
            replace(channels.setSleepDisabled, async (disabled) => {
                await new Promise((resolve) => setTimeout(resolve, state.sleepPromptDelayMs));
                if (!state.sleepPromptCancelled) state.sleepDisabled = !!disabled;
                return state.sleepDisabled;
            });
            replace(channels.browseFolder, () => state.browseFolder);
            // Both weather channels would reach Open-Meteo. The forecast answers
            // the `weather` stub (none, unless a test dresses Patch for one), and
            // the lookup answers from the table above.
            replace(channels.getWeather, () => {
                state.calls.getWeather++;
                return state.weather === 'never' ? new Promise(() => {}) : state.weather;
            });
            replace(channels.geocodeWeatherLocation, async (name) => {
                const stub = state.geocode[String(name)];
                if (stub === 'fail') throw new Error('geocoding is offline');
                if (!stub) return null;
                if (stub.delayMs) await new Promise((resolve) => setTimeout(resolve, stub.delayMs));
                return stub.location;
            });
            replace(channels.openExternal, (url) => {
                state.opened.push(String(url));
            });
            // The real peek asks `gh` for the PR and its diff.
            replace(channels.pullRequestPeek, (ref) => {
                const {repository, number} = ref as {repository: string; number: number};
                const key = `${repository}#${number}`;
                state.peeked.push(key);
                return (
                    state.pullRequestPeeks[key] ?? {
                        ref: {repository, number},
                        url: `https://github.com/${repository}/pull/${number}`,
                        pr: null,
                        files: [],
                        error: 'GitHub does not know this PR',
                    }
                );
            });
            // The real clipboard is the user's: a test that copies must not overwrite it.
            replace(channels.writeClipboard, (text) => {
                state.clipboard.push(String(text));
            });
            replace(channels.writeClipboardImage, (png) => {
                state.clipboardImages.push(Buffer.from(png as Uint8Array).toString('base64'));
            });
            replace(channels.openRepository, (projectPath) => {
                state.opened.push('repository:' + String(projectPath));
                return true;
            });

            // VM hosts (#276). The real handlers dial the agent over ssh; these answer
            // from `state.agent`, read at each call so `setHostStub(app, 'agent', …)` applies.
            replace(channels.agentStatus, () => state.agent.status);
            ipcMain.removeHandler(channels.agentInstall);
            ipcMain.handle(channels.agentInstall, async (event, projectPath) => {
                const path = String(projectPath);
                state.agentRequests.install.push(path);
                for (const line of state.agent.installLines) {
                    await new Promise((resolve) => setTimeout(resolve, state.agent.installLineDelayMs));
                    event.sender.send(events.agentInstallProgress, path, line);
                }
                // A stubbed registry learns of the agent as main's would on a real install.
                const hostOf = /^ssh:\/\/([^@/]+)@([^:/]+)(?::(\d+))?/.exec(path);
                const vm = hostOf
                    ? state.vmRegistry?.hosts.find(
                          (host) => host.key === `${hostOf[1]}@${hostOf[2]}:${hostOf[3] ?? '22'}`,
                      )
                    : undefined;
                if (state.agent.installResult.ok && vm) {
                    vm.agent = state.agent.status.installed;
                    vm.current = state.agent.status.current;
                    vm.connected = state.agent.status.connected;
                    event.sender.send(events.vmHostsChanged);
                }
                return state.agent.installResult;
            });
            replace(channels.agentCheckTools, () => state.agent.tools);
            replace(channels.agentHostSettings, () => state.agent.hostSettings);
            replace(channels.agentSetHostSettings, (projectPath, change) => {
                state.agentRequests.setHostSettings.push({
                    projectPath: String(projectPath),
                    change: change as Partial<HostSettings>,
                });
                if (!state.agent.hostSettings) return null;
                state.agent = {
                    ...state.agent,
                    hostSettings: {...state.agent.hostSettings, ...(change as Partial<HostSettings>)},
                };
                return state.agent.hostSettings;
            });
            replace(channels.agentOpenSetupTerminal, (projectPath) => {
                state.agentRequests.openSetupTerminal.push(String(projectPath));
                return state.agent.setupTerminal;
            });

            // Settings → VMs (#307), only when stubbed: in memory, read at each call so
            // `setHostStub(app, 'vmRegistry', …)` applies. Each change is pushed, as main does.
            if (state.vmRegistry) {
                const registry = (): VmRegistryStub => state.vmRegistry ?? {hosts: []};
                const changed = (event: {sender: {send(channel: string): void}}): void =>
                    event.sender.send(events.vmHostsChanged);
                ipcMain.removeHandler(channels.vmRegistryList);
                ipcMain.handle(channels.vmRegistryList, () => registry().hosts);
                ipcMain.removeHandler(channels.vmRegistryAdd);
                ipcMain.handle(
                    channels.vmRegistryAdd,
                    (event, input: {user: string; host: string; port?: number; name?: string}) => {
                        const port = Number(input.port) || 22;
                        const key = `${input.user}@${input.host}:${port}`;
                        const address = `${input.user}@${input.host}${port === 22 ? '' : ':' + port}`;
                        if (registry().hosts.some((vm) => vm.key === key)) {
                            return {ok: false, error: `${address} is already registered.`};
                        }
                        registry().hosts.push({
                            key,
                            user: input.user,
                            host: input.host,
                            port,
                            label: input.name || address,
                            agent: null,
                            current: false,
                            connected: false,
                            projects: [],
                        });
                        changed(event);
                        return {ok: true, key};
                    },
                );
                ipcMain.removeHandler(channels.vmRegistryRename);
                ipcMain.handle(channels.vmRegistryRename, (event, key, name) => {
                    const vm = registry().hosts.find((host) => host.key === key);
                    if (!vm) return false;
                    vm.label = String(name) || `${vm.user}@${vm.host}${vm.port === 22 ? '' : ':' + vm.port}`;
                    changed(event);
                    return true;
                });
                ipcMain.removeHandler(channels.vmRegistryRemove);
                ipcMain.handle(channels.vmRegistryRemove, (event, key) => {
                    const hosts = registry().hosts;
                    const at = hosts.findIndex((host) => host.key === key);
                    if (at < 0) return {ok: false, error: `${String(key)} is not a registered VM.`};
                    hosts.splice(at, 1);
                    changed(event);
                    return {ok: true};
                });
            }

            // Project hand-off (#276 stage 2). The real handlers run ssh and git against
            // the VM; these answer from `state.handoff`, read at each call.
            const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, state.handoff.lineDelayMs));
            replace(channels.handoffHosts, () => state.handoff.hosts);
            replace(channels.handoffPreview, (path) => {
                state.handoffRequests.preview.push(String(path));
                return state.handoff.preview;
            });
            ipcMain.removeHandler(channels.handoffRun);
            ipcMain.handle(channels.handoffRun, async (event, path, hostKey, ticked, choices) => {
                const localPath = String(path);
                state.handoffRequests.handOff.push({
                    localPath,
                    hostKey: String(hostKey),
                    ticked: Array.isArray(ticked) ? ticked.map(String) : [],
                    choices: choices && typeof choices === 'object' ? {...(choices as HandoffChoices)} : {},
                });
                for (const line of state.handoff.lines) {
                    await pause();
                    event.sender.send(events.handoffProgress, localPath, line);
                }
                return state.handoff.result;
            });
            replace(channels.handoffCopiesOf, (path) => state.handoff.copies[String(path)] ?? []);
            replace(channels.handoffOriginOf, (path) => state.handoff.origins[String(path)] ?? null);
            replace(channels.handoffCopyStatus, (path) => {
                state.handoffRequests.copyStatus.push(String(path));
                return state.handoff.copyStatus;
            });
            ipcMain.removeHandler(channels.handoffBringBack);
            ipcMain.handle(channels.handoffBringBack, async (event, path) => {
                const copyPath = String(path);
                state.handoffRequests.bringBack.push(copyPath);
                for (const line of state.handoff.bringBackLines) {
                    await pause();
                    event.sender.send(events.bringBackProgress, copyPath, line);
                }
                return state.handoff.bringBackResult;
            });
            replace(channels.handoffRemoveCopy, (path) => {
                state.handoffRequests.removeCopy.push(String(path));
                return state.handoff.removeResult;
            });

            // Where schedules run, and files dropped on a VM terminal (#276 stage 5).
            // The real handlers tell the agent over ssh, and upload over it; these
            // answer from `state.vmSchedules` and `state.droppedFiles`, read at each call.
            replace(channels.vmSchedulesWhere, (path) => {
                state.vmSchedulesRequests.where.push(String(path));
                return state.vmSchedules.where[String(path)] ?? null;
            });
            replace(channels.vmSchedulesRunOn, (localPath, copyPath) => {
                state.vmSchedulesRequests.runOn.push({
                    localPath: String(localPath),
                    copyPath: copyPath === null ? null : String(copyPath),
                });
                return state.vmSchedules.runOn;
            });
            replace(channels.droppedFilesToSession, (sessionId, localPaths) => {
                state.droppedFilesRequests.push({
                    sessionId: String(sessionId),
                    localPaths: Array.isArray(localPaths) ? localPaths.map(String) : [],
                });
                const {result, delayMs = 0} = state.droppedFiles;
                return new Promise((resolve) => setTimeout(() => resolve(result), delayMs));
            });

            // Session hand-off (#276 stage 3). The real handlers wait on the session's
            // turn and run ssh and git against the VM; these answer from
            // `state.sessionHandoff`, read at each call. A hand-off holding in its
            // `waiting` phase is kept here, by session, for Cancel to end.
            const waiting = new Map<string, () => void>();
            replace(channels.sessionHandoffPreview, (sessionId) => {
                state.sessionHandoffRequests.preview.push(String(sessionId));
                return state.sessionHandoff.preview;
            });
            ipcMain.removeHandler(channels.sessionHandoffRun);
            ipcMain.handle(channels.sessionHandoffRun, async (event, sessionId, hostKey, ticked) => {
                const id = String(sessionId);
                state.sessionHandoffRequests.handOff.push({
                    sessionId: id,
                    hostKey: String(hostKey),
                    ticked: Array.isArray(ticked) ? ticked.map(String) : [],
                });
                const stub = state.sessionHandoff;
                const push = (phase: SessionHandoffPhase): void =>
                    event.sender.send(events.sessionHandoffPhase, id, phase);
                let last: SessionHandoffPhase = {kind: 'failed', error: 'The stub has no phases'};
                for (const phase of stub.phases) {
                    await new Promise((resolve) => setTimeout(resolve, stub.phaseDelayMs));
                    push(phase);
                    last = phase;
                    if (phase.kind !== 'waiting') continue;
                    const cancelled = await new Promise<boolean>((resolve) => {
                        const timer = setTimeout(() => {
                            waiting.delete(id);
                            resolve(false);
                        }, stub.waitingMs);
                        waiting.set(id, () => {
                            clearTimeout(timer);
                            waiting.delete(id);
                            resolve(true);
                        });
                    });
                    if (cancelled) {
                        last = {kind: 'cancelled'};
                        push(last);
                        return last;
                    }
                }
                if (last.kind === 'done') {
                    event.sender.send(events.sessionStarted, id, last.copyPath);
                    event.sender.send(events.projectsChanged);
                }
                return last;
            });
            // A VM session's Bring back (#276). The real handlers ask the VM and run
            // git here; these answer from `state.sessionBringBack`, read at each call.
            replace(channels.sessionBringBackPreview, (sessionId) => {
                state.sessionBringBackRequests.preview.push(String(sessionId));
                return state.sessionBringBack.preview;
            });
            ipcMain.removeHandler(channels.sessionBringBackRun);
            ipcMain.handle(channels.sessionBringBackRun, async (event, sessionId, existing) => {
                const id = String(sessionId);
                const choice: 'reuse' | 'replace' | null =
                    existing === 'reuse' || existing === 'replace' ? existing : null;
                state.sessionBringBackRequests.bringBack.push({sessionId: id, existing: choice});
                const stub = state.sessionBringBack;
                let last: SessionBringBackPhase = {kind: 'failed', error: 'The stub has no phases'};
                for (const phase of stub.phases[choice ?? 'none']) {
                    await new Promise((resolve) => setTimeout(resolve, stub.phaseDelayMs));
                    event.sender.send(events.sessionBringBackPhase, id, phase);
                    last = phase;
                }
                return last;
            });
            replace(channels.sessionBringBackCancel, () => false);
            replace(channels.sessionHandoffCancel, (sessionId) => {
                const id = String(sessionId);
                state.sessionHandoffRequests.cancel.push(id);
                const cancel = waiting.get(id);
                if (!cancel) return false;
                cancel();
                return true;
            });
        },
        {stubs, channels: INVOKE, send: SEND, events: EVENT},
    );
}

/** What the renderer asked the VM hosts' stubs since the app launched. */
export async function agentRequests(app: ElectronApplication): Promise<AgentRequests> {
    return await app.evaluate(() => {
        const requests = (globalThis as WithStubs).__switchboardE2E.agentRequests;
        return {
            install: [...requests.install],
            setHostSettings: [...requests.setHostSettings],
            openSetupTerminal: [...requests.openSetupTerminal],
        };
    });
}

/** What the renderer asked the hand-off stubs since the app launched. */
export async function handoffRequests(app: ElectronApplication): Promise<HandoffRequests> {
    return await app.evaluate(() => {
        const requests = (globalThis as WithStubs).__switchboardE2E.handoffRequests;
        return {
            preview: [...requests.preview],
            handOff: requests.handOff.map((request) => ({
                ...request,
                ticked: [...request.ticked],
                choices: {...request.choices},
            })),
            copyStatus: [...requests.copyStatus],
            bringBack: [...requests.bringBack],
            removeCopy: [...requests.removeCopy],
        };
    });
}

/** What the renderer asked the session hand-off stubs since the app launched. */
export async function sessionHandoffRequests(app: ElectronApplication): Promise<SessionHandoffRequests> {
    return await app.evaluate(() => {
        const requests = (globalThis as WithStubs).__switchboardE2E.sessionHandoffRequests;
        return {
            preview: [...requests.preview],
            handOff: requests.handOff.map((request) => ({...request, ticked: [...request.ticked]})),
            cancel: [...requests.cancel],
        };
    });
}

/** What the renderer asked the session Bring back stubs since the app launched. */
export async function sessionBringBackRequests(app: ElectronApplication): Promise<SessionBringBackRequests> {
    return await app.evaluate(() => {
        const requests = (globalThis as WithStubs).__switchboardE2E.sessionBringBackRequests;
        return {preview: [...requests.preview], bringBack: requests.bringBack.map((request) => ({...request}))};
    });
}

/** What the renderer asked the schedules stubs since the app launched. */
export async function vmSchedulesRequests(app: ElectronApplication): Promise<VmSchedulesRequests> {
    return await app.evaluate(() => {
        const requests = (globalThis as WithStubs).__switchboardE2E.vmSchedulesRequests;
        return {where: [...requests.where], runOn: requests.runOn.map((request) => ({...request}))};
    });
}

/** Every upload of dropped files the renderer asked for since the app launched. */
export async function droppedFilesRequests(app: ElectronApplication): Promise<DroppedFilesRequest[]> {
    return await app.evaluate(() =>
        (globalThis as WithStubs).__switchboardE2E.droppedFilesRequests.map((request) => ({
            ...request,
            localPaths: [...request.localPaths],
        })),
    );
}

/** Everything the renderer typed into `sessionId`'s terminal since the app launched, joined. */
export async function terminalInput(app: ElectronApplication, sessionId: string): Promise<string> {
    return await app.evaluate(
        (_electron, sessionId) =>
            (globalThis as WithStubs).__switchboardE2E.terminalInputs
                .filter((input) => input.sessionId === sessionId)
                .map((input) => input.data)
                .join(''),
        sessionId,
    );
}

/** The sessions whose Session work page the renderer told main it closed, in order. */
export async function sessionWorkClosed(app: ElectronApplication): Promise<string[]> {
    return await app.evaluate(() => {
        return [...(globalThis as WithStubs).__switchboardE2E.sessionWorkClosed];
    });
}

/** What each Start session on an issue with an existing branch asked to do with it (null: nothing yet), in order. */
export async function existingBranchAsks(app: ElectronApplication): Promise<(string | null)[]> {
    return await app.evaluate(() => [...((globalThis as {__existingAsked?: (string | null)[]}).__existingAsked ?? [])]);
}

/** The actions the page asked main for, in order. */
export async function sessionWorkActions(app: ElectronApplication): Promise<ActionRequest[]> {
    return await app.evaluate(() => {
        return [...(globalThis as WithStubs).__switchboardE2E.sessionWorkActions];
    });
}

/** Every call the renderer made on a `queue:*` channel, in order (#315). */
export async function mergeQueueRequests(app: ElectronApplication): Promise<MergeQueueRequest[]> {
    return await app.evaluate(() => {
        return [...(globalThis as WithStubs).__switchboardE2E.mergeQueueRequests];
    });
}

/** The queued actions the page asked main to cancel, by id. */
export async function sessionWorkCancels(app: ElectronApplication): Promise<string[]> {
    return await app.evaluate(() => {
        return [...(globalThis as WithStubs).__switchboardE2E.sessionWorkCancels];
    });
}

/** Every write to your review the Session work page asked main for, in order. */
export async function sessionWorkReviews(app: ElectronApplication): Promise<ReviewWrite[]> {
    return await app.evaluate(() => {
        return [...(globalThis as WithStubs).__switchboardE2E.sessionWorkReviews];
    });
}

/** Change a stub mid-test (takes effect on the renderer's next request). */
export async function setHostStub<K extends keyof HostStubs>(
    app: ElectronApplication,
    key: K,
    value: HostStubs[K],
): Promise<void> {
    await app.evaluate(
        (_electron, {key, value}) => {
            ((globalThis as WithStubs).__switchboardE2E as unknown as Record<string, unknown>)[key] = value;
        },
        {key, value},
    );
}

/**
 * The URLs the app tried to open in a browser — PR chips, terminal links — and
 * `repository:<path>` for each "open repository" request.
 */
/** Every PR the peek asked main for, as `owner/repo#N`, in order. */
export async function peekedPullRequests(app: ElectronApplication): Promise<string[]> {
    return await app.evaluate(() => [...(globalThis as WithStubs).__switchboardE2E.peeked]);
}

export async function openedExternally(app: ElectronApplication): Promise<string[]> {
    return await app.evaluate(() => {
        return [...(globalThis as WithStubs).__switchboardE2E.opened];
    });
}

/**
 * Make every search fail in the main process, as an index that cannot parse a
 * query would if main did not already answer it with no results.
 */
export async function breakSearch(app: ElectronApplication): Promise<void> {
    await app.evaluate(({ipcMain}, channel) => {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, () => {
            throw new Error('fts5: syntax error');
        });
    }, INVOKE.search);
}

/** How often each counted stub has been called since the app launched. */
export async function hostStubCalls(app: ElectronApplication): Promise<HostStubCalls> {
    return await app.evaluate(() => {
        return {...(globalThis as WithStubs).__switchboardE2E.calls};
    });
}

/** Everything the app wrote to the clipboard (stubbed; the host's is never touched). */
export async function clipboardWrites(app: ElectronApplication): Promise<string[]> {
    return await app.evaluate(() => {
        return [...(globalThis as WithStubs).__switchboardE2E.clipboard];
    });
}

/** Every image the app wrote to the clipboard, as base64 PNG (stubbed, like `clipboardWrites`). */
export async function clipboardImages(app: ElectronApplication): Promise<string[]> {
    return await app.evaluate(() => {
        return [...(globalThis as WithStubs).__switchboardE2E.clipboardImages];
    });
}

/** Send the renderer an event, as main would. */
export async function pushEvent(app: ElectronApplication, channel: string, ...args: unknown[]): Promise<void> {
    await app.evaluate(
        ({BrowserWindow}, {channel, args}) => {
            BrowserWindow.getAllWindows()
                .find((w) => !w.webContents.getURL().includes('/quick-ask/'))
                ?.webContents.send(channel, ...args);
        },
        {channel, args},
    );
}

/**
 * Tell the renderer a remote session's connection is in some phase.
 *
 * The connection card lives in the session's terminal container, so the
 * session has to be open (clicked) first; opening it is also what starts the
 * fake `ssh`. Real transitions can be driven through `fakeSsh` instead — this
 * is for the phases that would need a real network to reach, or a precise
 * backoff delay.
 */
export async function pushRemoteStatus(
    app: ElectronApplication,
    sessionId: string,
    status: RemoteStatusPayload,
): Promise<void> {
    await pushEvent(app, EVENT.remoteStatus, sessionId, status);
}

/**
 * Make every "stop session" request fail with `error`, the way a PTY that
 * refuses to die would. For the paths that have to give up part-way — archiving
 * a whole project stops at the first session it cannot stop.
 */
export async function failStopSession(app: ElectronApplication, error: string): Promise<void> {
    await app.evaluate(
        ({ipcMain}, {channel, error}) => {
            ipcMain.removeHandler(channel);
            ipcMain.handle(channel, () => ({ok: false, error}));
        },
        {channel: INVOKE.stopSession, error},
    );
}

/**
 * Answer every "reconnect now" request with `result` instead of acting on it,
 * and remember which sessions asked. For the card's Retry button: what the
 * click asks main for is the thing under test, and a real early redial would
 * race the backoff it short-circuits.
 */
export async function stubReconnectRemote(app: ElectronApplication, result: {ok: boolean}): Promise<void> {
    await app.evaluate(
        ({ipcMain}, {channel, result}) => {
            const state = (globalThis as typeof globalThis & {__switchboardE2E: {reconnects?: string[]}})
                .__switchboardE2E;
            state.reconnects = [];
            ipcMain.removeHandler(channel);
            ipcMain.handle(channel, (_event, sessionId) => {
                state.reconnects!.push(String(sessionId));
                return result;
            });
        },
        {channel: INVOKE.reconnectRemote, result},
    );
}

/**
 * Answer every "open terminal" request as opened, without launching anything,
 * and remember which sessions asked. For a VM session (#276), whose real launch
 * waits on its host's agent over ssh: a test that only needs it on screen
 * (Session work's trigger puts it there first) must not dial a host.
 */
export async function stubOpenTerminal(app: ElectronApplication): Promise<void> {
    await app.evaluate(
        ({ipcMain}, {channel}) => {
            const state = (globalThis as typeof globalThis & {__switchboardE2E: {terminalsOpened?: string[]}})
                .__switchboardE2E;
            state.terminalsOpened = [];
            ipcMain.removeHandler(channel);
            ipcMain.handle(channel, (_event, sessionId) => {
                state.terminalsOpened!.push(String(sessionId));
                return {ok: true, reattached: false};
            });
        },
        {channel: INVOKE.openTerminal},
    );
}

/** The sessions the renderer asked to open a terminal for since `stubOpenTerminal`. */
export async function terminalsOpened(app: ElectronApplication): Promise<string[]> {
    return await app.evaluate(() => {
        const state = (globalThis as typeof globalThis & {__switchboardE2E: {terminalsOpened?: string[]}})
            .__switchboardE2E;
        return [...(state.terminalsOpened ?? [])];
    });
}

/** The sessions the renderer asked to reconnect since `stubReconnectRemote`. */
export async function reconnectRequests(app: ElectronApplication): Promise<string[]> {
    return await app.evaluate(() => {
        const state = (globalThis as typeof globalThis & {__switchboardE2E: {reconnects?: string[]}}).__switchboardE2E;
        return [...(state.reconnects ?? [])];
    });
}

/** Where the main window sits on screen, [x, y]. */
export async function windowPosition(app: ElectronApplication): Promise<number[]> {
    return await app.evaluate(({BrowserWindow}) =>
        BrowserWindow.getAllWindows()
            .find((w) => !w.webContents.getURL().includes('/quick-ask/'))!
            .getPosition(),
    );
}

/**
 * Quick Ask's ⌥Space, which Playwright cannot press. Under the harness main
 * holds a stand-in instead of the real global shortcut, and exposes it here.
 */
interface QuickAskHooks {
    press(): boolean;
    refuse(refusing: boolean): void;
    visible(): boolean;
    passingThrough(): boolean;
}

type WithTestHooks = typeof globalThis & {__switchboardTestHooks: {quickAsk: QuickAskHooks}};

/** Do what pressing ⌥Space does. False when main does not hold the key. */
export async function pressQuickAsk(app: ElectronApplication): Promise<boolean> {
    return await app.evaluate(() => (globalThis as WithTestHooks).__switchboardTestHooks.quickAsk.press());
}

/** Make every registration of ⌥Space fail from now on, as when another app holds it. */
export async function refuseQuickAskHotkey(app: ElectronApplication, refusing: boolean): Promise<void> {
    await app.evaluate((_electron, refusing) => {
        (globalThis as WithTestHooks).__switchboardTestHooks.quickAsk.refuse(refusing);
    }, refusing);
}

/** Whether the Quick Ask pop-up is showing. Under the harness it never comes on screen; this is main's word. */
export async function quickAskShowing(app: ElectronApplication): Promise<boolean> {
    return await app.evaluate(() => (globalThis as WithTestHooks).__switchboardTestHooks.quickAsk.visible());
}

/** Whether a click on the pop-up's window would go to the window underneath. */
export async function quickAskPassingThrough(app: ElectronApplication): Promise<boolean> {
    return await app.evaluate(() => (globalThis as WithTestHooks).__switchboardTestHooks.quickAsk.passingThrough());
}

/**
 * Record every call that could bring the main window, or the app, forward:
 * the window's `show`, `focus` and `moveTop`, its page's `focus`, and
 * `app.focus`. Under the harness the app is never active, so the window being
 * unfocused proves little; that none of these ran proves more.
 */
export async function watchMainWindowFocus(app: ElectronApplication): Promise<void> {
    await app.evaluate(({app: electronApp, BrowserWindow}) => {
        const calls: string[] = [];
        const spy = (target: Record<string, unknown>, method: string, name: string) => {
            const original = (target[method] as (...args: unknown[]) => unknown).bind(target);
            target[method] = (...args: unknown[]) => {
                calls.push(name);
                return original(...args);
            };
        };
        const window = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('/quick-ask/'))!;
        for (const method of ['show', 'focus', 'moveTop']) spy(window as never, method, `window.${method}`);
        spy(window.webContents as never, 'focus', 'webContents.focus');
        spy(electronApp as never, 'focus', 'app.focus');
        (globalThis as typeof globalThis & {__mainWindowFocusCalls?: string[]}).__mainWindowFocusCalls = calls;
    });
}

/** What `watchMainWindowFocus` has seen since it started. */
export async function mainWindowFocusCalls(app: ElectronApplication): Promise<string[]> {
    return await app.evaluate(() => [
        ...((globalThis as typeof globalThis & {__mainWindowFocusCalls?: string[]}).__mainWindowFocusCalls ?? []),
    ]);
}

/** Whether the main window has the focus, by main's word. */
export async function mainWindowFocused(app: ElectronApplication): Promise<boolean> {
    return await app.evaluate(
        ({BrowserWindow}) =>
            BrowserWindow.getAllWindows()
                .find((w) => !w.webContents.getURL().includes('/quick-ask/'))
                ?.isFocused() ?? false,
    );
}

/** Close the main window, leaving the app running in the Dock, as ⌘W does. */
export async function closeMainWindow(app: ElectronApplication): Promise<void> {
    await app.evaluate(({BrowserWindow}) => {
        BrowserWindow.getAllWindows()
            .find((w) => !w.webContents.getURL().includes('/quick-ask/'))!
            .close();
    });
}
