/**
 * The Bug manager page's work on a bug (#414, for #409): Fix, following the
 * Fix through its PR, marking the error fixed at the merge, and judging the
 * events that come after it.
 *
 * **Fix.** The bug's Bugsnag project must be linked to a local project. A
 * worktree of that project is made on `fix/bugsnag-<first 8 of the error
 * id>` (reused when it exists), and the prompt states the `/fix-bugsnag`
 * conventions itself (`fixPrompt`). Like an issue start, main only prepares:
 * the renderer starts Claude in the worktree and says so (`fixStarted`),
 * which moves the item to In progress.
 *
 * **Following.** Every minute, and when a session ends, each Fix in progress
 * is read from its session (running, waiting on you, ended) and its branch's
 * PR (`gh`), with its place in the merge queue, into a stage (`workProgress`).
 * A merged PR finishes the item; a session that ended with no PR puts it back
 * in the inbox, read, "Tried, no PR".
 *
 * **Marking fixed.** At the merge Bugsnag is told the error is fixed, once:
 * the item remembers it did (`markedFixed`), and a failed call is tried again
 * on the next round rather than repeated.
 *
 * **Seen again.** A done bug whose last event is after the merge (Bugsnag
 * reopens a fixed error on a new event) gets those events judged against the
 * first tag that contains the merge commit (`judgeSeenAgain`): regressed
 * puts it back unread, older releases ask you (Close again, or Treat as
 * regressed).
 *
 * The detail pane's trend, release and frames are read from Bugsnag on
 * demand and kept a while, one request at a time, so a page full of
 * sparklines never bursts past Bugsnag's rate limit.
 */
import {bugsnagErrorUrl, fixBranch, fixPrompt} from '../../domain/inbox/fix';
import {finish, markRegressed, returnToInbox, setStage, startWork, updateFix} from '../../domain/inbox/items';
import {judgeSeenAgain} from '../../domain/inbox/seen-again';
import {stageLabel, workProgress} from '../../domain/inbox/stage';
import {frameLine} from '../../domain/bugsnag/model';
import {localProjectFor} from '../../domain/bugsnag/connection';
import {gitHubRepository} from '../../domain/project/repo-url';
import {isRemoteProjectPath} from '../../domain/project/remote-target';
import {BranchWorktrees, type BranchSessionCandidate, type BranchWorktreesDeps} from './support/branch-worktrees';
import type {BugFacts, InboxItem, InboxStage, BugFix} from '../../domain/inbox/model';
import type {BranchPullRequest, WorkSession} from '../../domain/inbox/stage';
import type {FixTag} from '../../domain/inbox/seen-again';
import type {BugsnagEventDetail, BugsnagProject} from '../../domain/bugsnag/model';
import type {BugLinkFacts} from '../../domain/session/links';
import type {BugsnagApi} from '../ports/bugsnag-api';
import type {Clock, TimerHandle, Timers} from '../ports/clock';
import type {GitHubCli} from '../ports/github-cli';
import type {GitRemotes} from '../ports/git-remotes';
import type {Logger} from '../ports/logger';
import type {ActiveSession} from '../model/active-session';
import type {CliStateChange} from '../../domain/terminal/osc';
import type {BugsnagConnectionService} from './bugsnag-connection-service';
import type {InboxService} from './inbox-service';
import type {MergeQueueWatchService} from './merge-queue-watch-service';

/** How often the Fixes in progress are followed. */
export const FIX_FOLLOW_INTERVAL_MS = 60_000;
/** A session not running this long after launch, and never seen ending, counts as ended. */
export const SESSION_GRACE_MS = 2 * 60_000;
/** How long a bug's detail (trend, releases, frames) is kept. */
export const DETAIL_KEPT_MS = 10 * 60_000;
/** How long a row's sparkline is kept. */
export const TREND_KEPT_MS = 30 * 60_000;
/** How long the Bugsnag project list (for "Open in Bugsnag") is kept. */
const PROJECTS_KEPT_MS = 60 * 60_000;
/** Tags checked for the merge commit, oldest after the merge first. */
const MAX_TAGS_COMPARED = 8;
/** In-project frames the detail and the prompt show. */
const TOP_FRAMES = 5;

/** What a Fix needs prepared before the renderer starts Claude. */
export type FixPreparation =
    | {ok: true; projectPath: string; worktreePath: string; branch: string; prompt: string}
    | {ok: false; reason: string; unlinked?: true};

/** One release an event came from. */
export interface ReleaseSeen {
    version: string | null;
    /** ISO. */
    at: string;
}

/** The detail pane's reads of a bug. */
export interface BugDetail {
    /** Events per day for the last 7 days, oldest first; empty when Bugsnag could not say. */
    trend: number[];
    /** The top frames of its newest event, in-project ones. */
    frames: {line: string; inProject: boolean}[];
    first: ReleaseSeen | null;
    last: ReleaseSeen | null;
    /** The error on the Bugsnag dashboard. */
    url: string | null;
    /** Fix sessions need the bugsnag MCP to read the error and link their PR. */
    mcpMissing: boolean;
}

export interface BugFixServiceDeps extends BranchWorktreesDeps<BranchSessionCandidate> {
    inbox: Pick<InboxService, 'item' | 'list' | 'update'>;
    bugsnag: Pick<BugsnagConnectionService, 'api' | 'settings' | 'mcpMissing'>;
    remotes: GitRemotes;
    github: Pick<GitHubCli, 'pullRequestForBranch' | 'recentTags' | 'refContains'>;
    mergeQueue: Pick<MergeQueueWatchService, 'placeOf'>;
    /** Whether a session runs in this worktree now. */
    sessionIn(worktree: string): boolean;
    /** Whether the project tags its releases (Settings, or detected). */
    releasesTagged(projectPath: string): Promise<boolean>;
    clock: Clock;
    timers: Timers;
    log: Logger;
    agentlessRemote?: (projectPath: string) => boolean;
}

interface Prepared {
    projectPath: string;
    repository: string;
    worktreePath: string;
    branch: string;
}

export class BugFixService {
    private readonly worktrees: BranchWorktrees;
    /** What `prepareFix` made, until the renderer says the session started. */
    private readonly prepared = new Map<string, Prepared>();
    /** Worktrees whose session waits on you. */
    private readonly waiting = new Set<string>();
    /** Errors being marked fixed right now, so a round never sends it twice. */
    private readonly fixing = new Set<string>();
    private readonly details = new Map<string, {at: number; detail: BugDetail}>();
    private readonly trends = new Map<string, {at: number; trend: number[]}>();
    private projects: {at: number; list: BugsnagProject[]} | null = null;
    /** Bugsnag reads, one at a time. */
    private reads: Promise<unknown> = Promise.resolve();
    private interval: TimerHandle | null = null;
    private following: Promise<void> | null = null;
    private readonly startedAt: number;

    constructor(private readonly deps: BugFixServiceDeps) {
        this.worktrees = new BranchWorktrees(deps);
        this.startedAt = deps.clock.now();
    }

    public start(): void {
        if (this.interval) return;
        this.interval = this.deps.timers.setInterval(() => void this.follow(), FIX_FOLLOW_INTERVAL_MS);
    }

    public stop(): void {
        this.deps.timers.clearInterval(this.interval);
        this.interval = null;
    }

    // ── Fix ──

    /** The worktree and prompt of a Fix on the bug at `key`, or why there is none. */
    public async prepareFix(key: string): Promise<FixPreparation> {
        const item = this.deps.inbox.item(key);
        if (!item || item.facts.kind !== 'bug') return {ok: false, reason: 'That bug is no longer in the inbox'};
        const facts = item.facts;
        const local = localProjectFor(this.deps.bugsnag.settings(), facts.projectId);
        if (!local) return {ok: false, reason: 'Link a project first', unlinked: true};
        if ((this.deps.agentlessRemote ?? isRemoteProjectPath)(local)) {
            return {ok: false, reason: 'A Fix can only start in a local project or on a VM'};
        }
        const root = await this.deps.git.mainCheckout(local);
        if (!root) return {ok: false, reason: 'Not a git repository: ' + local};
        const origin = await this.deps.remotes.originUrl(root);
        const repository = origin ? gitHubRepository(origin) : '';
        if (!repository) return {ok: false, reason: 'A Fix needs the project on GitHub, to follow its PR'};

        const made = await this.worktrees.prepare({root, branch: fixBranch(facts.errorId), existing: 'reuse'});
        if (!made.ok) return {ok: false, reason: made.reason};
        const detail = await this.detail(key).catch(() => null);
        const prompt = fixPrompt({
            facts,
            projectName: this.projectName(facts.projectId),
            branch: made.branch,
            url: detail?.url ?? null,
            frames: detail?.frames.filter((frame) => frame.inProject).map((frame) => frame.line) ?? [],
        });
        this.prepared.set(key, {projectPath: root, repository, worktreePath: made.worktreePath, branch: made.branch});
        return {ok: true, projectPath: root, worktreePath: made.worktreePath, branch: made.branch, prompt};
    }

    /** The renderer started the Fix session `prepareFix` prepared: the bug is in progress. */
    public fixStarted(key: string, sessionId: string): InboxItem | null {
        const prepared = this.prepared.get(key);
        if (!prepared) return this.deps.inbox.item(key);
        this.prepared.delete(key);
        const now = this.deps.clock.now();
        const fix: BugFix = {
            projectPath: prepared.projectPath,
            repository: prepared.repository,
            branch: prepared.branch,
            worktree: prepared.worktreePath,
            sessionId,
            startedAt: now,
            pr: null,
            queuePosition: null,
            checks: null,
            sessionEnded: false,
            ended: null,
            mergedAt: null,
            mergeCommit: null,
            markedFixed: false,
            quietSince: null,
            seenAgain: null,
            timeline: [{at: now, text: `Fix pressed · worktree ${prepared.branch}`}],
        };
        return this.deps.inbox.update(key, (item) => ({
            ...startWork(item, 'working'),
            work: {branch: prepared.branch, sessionId, pullRequest: null},
            fix,
        }));
    }

    /** Stop working on it: back in the inbox, read. The worktree and session are left as they are. */
    public stopWorking(key: string): InboxItem | null {
        return this.deps.inbox.update(key, (item) =>
            returnToInbox(withStep(item, this.deps.clock.now(), 'Stopped working on it'), 'stopped'),
        );
    }

    // ── Seen again ──

    /** Close again: the events after the merge came from an older release; mark it fixed again and stay in Done. */
    public async closeAgain(key: string): Promise<InboxItem | null> {
        const item = this.deps.inbox.item(key);
        if (!item || item.facts.kind !== 'bug' || !item.fix?.seenAgain) return item;
        const api = this.deps.bugsnag.api();
        if (!api) throw new Error('No Bugsnag token is saved');
        await api.fix(item.facts.projectId, item.facts.errorId);
        const now = this.deps.clock.now();
        return this.deps.inbox.update(key, (current) =>
            updateFix(current, (work) => ({
                ...work,
                seenAgain: null,
                markedFixed: true,
                quietSince: now,
                timeline: [...work.timeline, {at: now, text: 'Seen again from an older release · closed again'}],
            })),
        );
    }

    /** Treat the events after the merge as a regression: back in the inbox, unread. */
    public treatAsRegressed(key: string): InboxItem | null {
        const now = this.deps.clock.now();
        return this.deps.inbox.update(key, (item) =>
            markRegressed(
                updateFix(item, (work) => ({
                    ...work,
                    seenAgain: null,
                    quietSince: now,
                    timeline: [...work.timeline, {at: now, text: 'Regressed after the merge'}],
                })),
            ),
        );
    }

    // ── Sessions ──

    /** A session's CLI state (the lifecycle's observer): a waiting session needs you. */
    public cliStateChanged(_sessionId: string, session: ActiveSession, change: CliStateChange): void {
        if (change.kind === 'needs-attention') this.waiting.add(session.projectPath);
        else if (change.kind === 'busy' && change.busy) this.waiting.delete(session.projectPath);
    }

    /** A session ended: a Fix in its worktree is followed at once. */
    public sessionEnded(_sessionId: string, session: ActiveSession): void {
        this.waiting.delete(session.projectPath);
        const now = this.deps.clock.now();
        for (const item of this.deps.inbox.list('bug')) {
            if (item.state.kind !== 'inProgress' || item.fix?.worktree !== session.projectPath) continue;
            this.deps.inbox.update(item.key, (current) =>
                withStep(
                    updateFix(current, (work) => ({...work, sessionEnded: true})),
                    now,
                    'Session ended',
                ),
            );
        }
        void this.follow();
    }

    // ── Following ──

    /** Follow every Fix in progress, finish the marks, and judge done bugs seen again. One round at a time. */
    public follow(): Promise<void> {
        if (this.following) return this.following;
        this.following = this.followAll()
            .catch((err) => this.deps.log.error('[bug-fix] following failed:', (err as Error).message))
            .finally(() => {
                this.following = null;
            });
        return this.following;
    }

    private async followAll(): Promise<void> {
        for (const item of this.deps.inbox.list('bug')) {
            if (!item.fix) continue;
            try {
                if (item.state.kind === 'inProgress') await this.followWork(item, item.fix);
                const now = this.deps.inbox.item(item.key);
                if (now?.state.kind === 'done' && now.fix?.mergedAt) {
                    if (!now.fix.markedFixed) await this.markFixed(now);
                    else if (!now.fix.seenAgain) await this.judgeSeenAgain(now, now.fix);
                }
            } catch (err) {
                this.deps.log.warn(`[bug-fix] ${item.key} not followed:`, (err as Error).message);
            }
        }
    }

    private async followWork(item: InboxItem, work: BugFix): Promise<void> {
        const read = await this.deps.github.pullRequestForBranch(work.repository, work.branch);
        if (!read) return; // `gh` could not be asked: the stage stands.
        const pr = read.pr;
        const queuePosition =
            pr && (pr.state === 'open' || pr.state === 'draft')
                ? this.deps.mergeQueue.placeOf(work.repository, pr.number)
                : null;
        const progress = workProgress(
            this.sessionState(work),
            pr ? {state: pr.state, checks: pr.checks.state, queuePosition} : null,
        );
        const now = this.deps.clock.now();
        if (progress.kind === 'noPr') {
            this.deps.inbox.update(item.key, (current) =>
                returnToInbox(withStep(current, now, 'Session ended without a PR'), 'noPr'),
            );
            return;
        }
        this.deps.inbox.update(item.key, (current) => withPullRequest(current, pr, queuePosition, now));
        if (progress.kind === 'merged') {
            const mergedAt = pr?.mergedAt ? Date.parse(pr.mergedAt) : now;
            const done = this.deps.inbox.update(item.key, (current) =>
                finish(
                    updateFix(withStep(current, mergedAt, `PR #${pr?.number} merged`), (w) => ({
                        ...w,
                        mergedAt,
                        mergeCommit: pr?.mergeCommit ?? null,
                        quietSince: mergedAt,
                        queuePosition: null,
                    })),
                    now,
                ),
            );
            if (done) await this.markFixed(done);
            return;
        }
        this.deps.inbox.update(item.key, (current) => {
            const staged = setStage(current, progress.stage);
            return staged === current ? current : withStep(staged, now, stageStep(progress.stage, queuePosition));
        });
    }

    private sessionState(work: BugFix): WorkSession {
        if (this.deps.sessionIn(work.worktree)) return this.waiting.has(work.worktree) ? 'needsYou' : 'running';
        if (work.sessionEnded) return 'ended';
        // Not running, and never seen ending: a session lost to a quit counts as ended once the app has had time to restore it.
        const now = this.deps.clock.now();
        return now - this.startedAt >= SESSION_GRACE_MS && now - work.startedAt >= SESSION_GRACE_MS
            ? 'ended'
            : 'running';
    }

    /** Tell Bugsnag the error is fixed, once: a failure is tried again next round. */
    private async markFixed(item: InboxItem): Promise<void> {
        if (item.facts.kind !== 'bug' || !item.fix || item.fix.markedFixed || this.fixing.has(item.key)) return;
        const api = this.deps.bugsnag.api();
        if (!api) return;
        this.fixing.add(item.key);
        try {
            await api.fix(item.facts.projectId, item.facts.errorId);
            const now = this.deps.clock.now();
            this.deps.inbox.update(item.key, (current) =>
                withStep(
                    updateFix(current, (work) => ({...work, markedFixed: true})),
                    now,
                    'Marked fixed in Bugsnag',
                ),
            );
        } catch (err) {
            this.deps.log.warn(`[bug-fix] ${item.key} not marked fixed:`, (err as Error).message);
        } finally {
            this.fixing.delete(item.key);
        }
    }

    private async judgeSeenAgain(item: InboxItem, work: BugFix): Promise<void> {
        if (item.facts.kind !== 'bug' || work.quietSince === null || !work.mergedAt) return;
        const facts = item.facts;
        const lastSeen = Date.parse(facts.lastSeen);
        if (!Number.isFinite(lastSeen) || lastSeen <= work.quietSince) return;
        const api = this.deps.bugsnag.api();
        if (!api) return;
        const since = work.quietSince;
        const events = (await this.read(() => api.eventsSince(facts.projectId, facts.errorId, new Date(since)))).filter(
            (event) => Date.parse(event.receivedAt) > since,
        );
        if (events.length === 0) return;
        const tagged = await this.deps.releasesTagged(work.projectPath);
        const tag =
            tagged && work.mergeCommit
                ? await this.firstTagWith(work.repository, work.mergeCommit, work.mergedAt)
                : null;
        const verdict = judgeSeenAgain(events, tag, tagged);
        if (!verdict) return;
        if (verdict.kind === 'regressed') {
            this.treatAsRegressed(item.key);
            return;
        }
        const {kind: _kind, ...notice} = verdict;
        const now = this.deps.clock.now();
        this.deps.inbox.update(item.key, (current) =>
            updateFix(current, (w) => ({
                ...w,
                seenAgain: notice,
                timeline: [...w.timeline, {at: now, text: `Seen again: ${notice.events} events after the merge`}],
            })),
        );
    }

    /** The first tag made after the merge that contains its commit; null when none does (yet). */
    private async firstTagWith(repository: string, sha: string, mergedAt: number): Promise<FixTag | null> {
        const tags = await this.deps.github.recentTags(repository);
        if (!tags) return null;
        // A lightweight tag carries its commit's date, which is the merge's at the earliest.
        const after = tags
            .filter((tag) => Date.parse(tag.at) >= mergedAt - 60_000)
            .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
            .slice(0, MAX_TAGS_COMPARED);
        for (const tag of after) {
            if (await this.deps.github.refContains(repository, tag.name, sha)) return tag;
        }
        return null;
    }

    // ── What the page reads ──

    /** The detail pane's reads of the bug at `key`: its trend, first and last release, and top frames. */
    public async detail(key: string): Promise<BugDetail | null> {
        const item = this.deps.inbox.item(key);
        if (!item || item.facts.kind !== 'bug') return null;
        const facts = item.facts;
        const now = this.deps.clock.now();
        const kept = this.details.get(key);
        if (kept && now - kept.at < DETAIL_KEPT_MS) return kept.detail;
        const api = this.deps.bugsnag.api();
        if (!api) return null;
        const [trend, latest, first, project] = [
            await this.trendOf(api, facts),
            await this.read(() => api.eventDetail(facts.projectId, facts.errorId, 'latest')).catch(() => null),
            await this.read(() => api.eventDetail(facts.projectId, facts.errorId, 'first')).catch(() => null),
            await this.project(api, facts.projectId),
        ];
        const detail: BugDetail = {
            trend,
            frames: topFrames(latest),
            first: first ? {version: first.appVersion, at: first.receivedAt} : null,
            last: latest ? {version: latest.appVersion, at: latest.receivedAt} : null,
            url: bugsnagErrorUrl(project?.htmlUrl ?? null, facts.errorId),
            mcpMissing: this.deps.bugsnag.mcpMissing(),
        };
        this.details.set(key, {at: now, detail});
        return detail;
    }

    /**
     * The session tray's link to the error a Fix in this worktree works on,
     * from what is kept now: the tray never waits on Bugsnag. Until the
     * Bugsnag project list is kept (it is read for the detail pane and every
     * Fix), there is no dashboard URL, so no link; the list is read behind
     * the answer for the next one.
     */
    public fixLink(worktree: string): BugLinkFacts | null {
        const item = this.deps.inbox
            .list('bug')
            .find((candidate) => candidate.state.kind === 'inProgress' && candidate.fix?.worktree === worktree);
        if (!item || item.facts.kind !== 'bug') return null;
        const facts = item.facts;
        const kept = this.projects?.list.find((project) => project.id === facts.projectId);
        if (!kept) {
            const api = this.deps.bugsnag.api();
            if (api) void this.project(api, facts.projectId);
        }
        const url = bugsnagErrorUrl(kept?.htmlUrl ?? null, facts.errorId);
        if (!url) return null;
        return {
            title: [facts.errorClass, facts.message].filter(Boolean).join(': ') || facts.errorId,
            url,
            project: this.projectName(facts.projectId),
        };
    }

    /** A row's sparkline: events per day for the last 7 days, oldest first; empty when unknown. */
    public async trend(key: string): Promise<number[]> {
        const item = this.deps.inbox.item(key);
        const api = this.deps.bugsnag.api();
        if (!item || item.facts.kind !== 'bug' || !api) return [];
        return this.trendOf(api, item.facts);
    }

    private async trendOf(api: BugsnagApi, facts: BugFacts): Promise<number[]> {
        const key = `bug:${facts.projectId}:${facts.errorId}`;
        const now = this.deps.clock.now();
        const kept = this.trends.get(key);
        if (kept && now - kept.at < TREND_KEPT_MS) return kept.trend;
        try {
            const buckets = await this.read(() => api.errorTrend(facts.projectId, facts.errorId, 7));
            const trend = buckets.map((bucket) => bucket.events);
            this.trends.set(key, {at: now, trend});
            return trend;
        } catch (err) {
            this.deps.log.warn(`[bug-fix] trend of ${key} not read:`, (err as Error).message);
            return [];
        }
    }

    private async project(api: BugsnagApi, projectId: string): Promise<BugsnagProject | null> {
        const now = this.deps.clock.now();
        if (!this.projects || now - this.projects.at >= PROJECTS_KEPT_MS) {
            try {
                this.projects = {at: now, list: await this.read(() => api.listProjects())};
            } catch {
                return null;
            }
        }
        return this.projects.list.find((project) => project.id === projectId) ?? null;
    }

    private projectName(projectId: string): string {
        return this.deps.bugsnag.settings().projects.find((project) => project.id === projectId)?.name || projectId;
    }

    /** Run a Bugsnag read after the ones before it. */
    private read<T>(call: () => Promise<T>): Promise<T> {
        const next = this.reads.then(call, call);
        this.reads = next.catch(() => undefined);
        return next;
    }
}

/** The work's PR, checks and queue place as read now, with a step when the PR first shows. */
function withPullRequest(
    item: InboxItem,
    pr: BranchPullRequest | null,
    queuePosition: number | null,
    now: number,
): InboxItem {
    const opened = pr && item.fix && item.fix.pr?.number !== pr.number;
    const updated = updateFix(item, (work) => {
        const ref = pr ? {number: pr.number, url: pr.url} : work.pr;
        const checks = pr
            ? {passed: pr.checks.passed, total: pr.checks.total, failing: [...pr.checks.failing]}
            : work.checks;
        const same =
            ref?.number === work.pr?.number &&
            ref?.url === work.pr?.url &&
            queuePosition === work.queuePosition &&
            JSON.stringify(checks) === JSON.stringify(work.checks);
        return same ? work : {...work, pr: ref, checks, queuePosition};
    });
    if (!opened) return updated;
    // The shared work names the PR too, as the Issue manager's does.
    const named = updated.work ? {...updated, work: {...updated.work, pullRequest: pr.number}} : updated;
    return withStep(named, now, `PR #${pr.number} opened`);
}

function withStep(item: InboxItem, at: number, text: string): InboxItem {
    return updateFix(item, (work) => ({...work, timeline: [...work.timeline, {at, text}]}));
}

function stageStep(stage: InboxStage, queuePosition: number | null): string {
    switch (stage) {
        case 'ciFailing':
            return 'CI failing';
        case 'needsYou':
            return 'The session needs you';
        case 'queue':
            return queuePosition
                ? `In the merge queue, ${stageLabel('queue', queuePosition).slice('Queue · '.length)}`
                : 'In the merge queue';
        default:
            return stageLabel(stage);
    }
}

/** The newest event's top frames: its in-project ones, or the top few when it has none. */
function topFrames(event: BugsnagEventDetail | null): {line: string; inProject: boolean}[] {
    if (!event) return [];
    const own = event.frames.filter((frame) => frame.inProject);
    const frames = own.length > 0 ? own : event.frames;
    return frames.slice(0, TOP_FRAMES).map((frame) => ({line: frameLine(frame), inProject: frame.inProject}));
}
