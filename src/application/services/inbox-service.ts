/**
 * The managers' inbox (#413, for #409): the pollers that fill it, the store
 * that keeps it, and what the managers' pages do to its items.
 *
 * **Polling.** Every five minutes, whatever is on screen, and once at start:
 *
 * - each opted-in Bugsnag project, on the saved token: its open errors,
 *   listed over their whole life and over the last 24 hours and 7 days for
 *   the trend (`bugFacts`);
 * - each repository of a project with Watch issues on: its open issues
 *   through the user's own `gh`, the loose ones unassigned or assigned to
 *   them kept (`looseIssues`).
 *
 * Each source's answer is folded in on its own, as soon as it comes, by the
 * domain's state machine (`syncSource`), and written at once, so an action
 * taken while a poll waits on another source is never overwritten by it. A
 * source that could not be asked (Bugsnag down, `gh` signed out) keeps the
 * items it had, as they were. A source no longer watched loses the items
 * still in the inbox's own states. After the sources, timed snoozes that are
 * up wake and done items older than seven days go.
 *
 * Every change is pushed to the renderer as both managers' counts
 * (`inboxChanged`); the pages ask for the items themselves.
 */
import {bugFacts} from '../../domain/inbox/bugs';
import {
    expired,
    finish,
    inboxSummary,
    markRead,
    markRegressed,
    returnToInbox,
    setNotes,
    setStage,
    snooze,
    startWork,
    syncSource,
    toBacklog,
    unwatched,
    wakeDue,
} from '../../domain/inbox/items';
import {looseIssues} from '../../domain/inbox/loose-issues';
import {inboxKey} from '../../domain/inbox/model';
import {gitHubRepository} from '../../domain/project/repo-url';
import {isRemoteProjectPath} from '../../domain/project/remote-target';
import {resolveWatchIssues} from '../../domain/settings/inbox-settings';
import type {SyncContext} from '../../domain/inbox/items';
import type {InboxFacts, InboxItem, InboxManager, InboxStage, InboxSummary} from '../../domain/inbox/model';
import type {BugsnagError} from '../../domain/bugsnag/model';
import type {BugsnagApi, ErrorQuery} from '../ports/bugsnag-api';
import type {Clock, TimerHandle, Timers} from '../ports/clock';
import type {GitHubCli} from '../ports/github-cli';
import type {GitRemotes} from '../ports/git-remotes';
import type {GitWorkspace} from '../ports/git-workspace';
import type {InboxStore} from '../ports/inbox-store';
import type {Logger} from '../ports/logger';
import type {RendererGateway} from '../ports/renderer-gateway';
import type {BugsnagConnectionService} from './bugsnag-connection-service';
import type {SettingsService} from './settings-service';

/** How often both managers are polled. */
export const INBOX_POLL_INTERVAL_MS = 5 * 60_000;

/** Errors read per list, 100 a page: a project with more open errors than this is read capped. */
export const MAX_ERROR_PAGES = 5;
const ERRORS_PER_PAGE = 100;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface InboxServiceDeps {
    store: InboxStore;
    bugsnag: Pick<BugsnagConnectionService, 'api' | 'settings'>;
    github: Pick<GitHubCli, 'inboxIssuesIn'>;
    /** The local projects, whose Watch issues switch says which repositories are watched. */
    projects: () => string[];
    settings: Pick<SettingsService, 'project'>;
    git: Pick<GitWorkspace, 'worktreeRoot'>;
    remotes: GitRemotes;
    renderer: Pick<RendererGateway, 'inboxChanged'>;
    clock: Clock;
    timers: Timers;
    log: Logger;
    /** An ssh project without an agent: no git or `gh` to ask. Every ssh project unless given. */
    agentlessRemote?: (projectPath: string) => boolean;
}

export class InboxService {
    private readonly items = new Map<string, InboxItem>();
    private interval: TimerHandle | null = null;
    private polling: Promise<void> | null = null;

    constructor(private readonly deps: InboxServiceDeps) {
        for (const item of deps.store.all()) this.items.set(item.key, item);
    }

    /** Poll now and every five minutes after. */
    public start(): void {
        if (this.interval) return;
        this.interval = this.deps.timers.setInterval(() => void this.poll(), INBOX_POLL_INTERVAL_MS);
        void this.poll();
    }

    public stop(): void {
        this.deps.timers.clearInterval(this.interval);
        this.interval = null;
    }

    /** Poll every source once. A poll asked for while one runs is that one. */
    public poll(): Promise<void> {
        if (this.polling) return this.polling;
        this.polling = this.pollAll()
            .catch((err) => this.deps.log.error('[inbox] polling failed:', (err as Error).message))
            .finally(() => {
                this.polling = null;
            });
        return this.polling;
    }

    /** Both managers' counts. */
    public summary(): InboxSummary {
        return inboxSummary([...this.items.values()]);
    }

    /** A manager's items, or both managers' when none is named. */
    public list(manager?: InboxManager): InboxItem[] {
        return [...this.items.values()].filter((item) => !manager || item.manager === manager);
    }

    public item(key: string): InboxItem | null {
        return this.items.get(key) ?? null;
    }

    // ── What the pages do to an item; each answers the item after, or null for a key it does not hold ──

    public markRead(key: string): InboxItem | null {
        return this.change(key, markRead);
    }

    /** Snooze until `until` (epoch ms), or until it changes (null). */
    public snooze(key: string, until: number | null): InboxItem | null {
        return this.change(key, (item) => snooze(item, until));
    }

    public backlog(key: string): InboxItem | null {
        return this.change(key, toBacklog);
    }

    public setNotes(key: string, notes: string): InboxItem | null {
        return this.change(key, (item) => setNotes(item, notes));
    }

    public startWork(key: string, stage?: InboxStage): InboxItem | null {
        return this.change(key, (item) => startWork(item, stage));
    }

    public setStage(key: string, stage: InboxStage): InboxItem | null {
        return this.change(key, (item) => setStage(item, stage));
    }

    public finish(key: string): InboxItem | null {
        return this.change(key, (item) => finish(item, this.deps.clock.now()));
    }

    public returnToInbox(key: string): InboxItem | null {
        return this.change(key, returnToInbox);
    }

    public markRegressed(key: string): InboxItem | null {
        return this.change(key, markRegressed);
    }

    private change(key: string, apply: (item: InboxItem) => InboxItem): InboxItem | null {
        const before = this.items.get(key);
        if (!before) return null;
        const after = apply(before);
        if (after !== before) this.commit([after], []);
        return after;
    }

    // ── Polling ──

    private async pollAll(): Promise<void> {
        await this.pollBugs();
        await this.pollIssues();
        const now = this.deps.clock.now();
        const items = [...this.items.values()];
        this.commit(wakeDue(items, now), expired(items, now));
    }

    private async pollBugs(): Promise<void> {
        const settings = this.deps.bugsnag.settings();
        const optedIn = settings.projects.filter((project) => project.optedIn).map((project) => project.id);
        this.commit([], unwatched([...this.items.values()], 'bug', new Set(optedIn)));
        if (optedIn.length === 0) return;
        const api = this.deps.bugsnag.api();
        if (!api) return;
        for (const projectId of optedIn) {
            let read: {facts: InboxFacts[]; complete: boolean};
            try {
                read = await this.readBugs(api, projectId);
            } catch (err) {
                this.deps.log.warn(`[inbox] Bugsnag project ${projectId} not read:`, (err as Error).message);
                continue;
            }
            this.sync('bug', projectId, read.facts, {complete: read.complete, viewer: null});
        }
    }

    private async readBugs(api: BugsnagApi, projectId: string): Promise<{facts: InboxFacts[]; complete: boolean}> {
        const now = this.deps.clock.now();
        const open = await allErrors(api, projectId, {});
        const day = await allErrors(api, projectId, {since: new Date(now - DAY_MS)});
        const week = await allErrors(api, projectId, {since: new Date(now - 7 * DAY_MS)});
        return {facts: bugFacts(projectId, open.errors, day.errors, week.errors), complete: open.complete};
    }

    private async pollIssues(): Promise<void> {
        const repositories = await this.watchedRepositories();
        this.commit([], unwatched([...this.items.values()], 'issue', new Set(repositories)));
        for (const repository of repositories) {
            const answer = await this.deps.github.inboxIssuesIn(repository);
            if (!answer) {
                this.deps.log.warn(`[inbox] issues of ${repository} not read`);
                continue;
            }
            const facts = looseIssues(repository, answer);
            const kept = new Set(facts.map(inboxKey));
            const excluded = new Set(answer.issues.map(inboxKey).filter((key) => !kept.has(key)));
            this.sync('issue', repository, facts, {complete: answer.complete, viewer: answer.viewer, excluded});
        }
    }

    /** The GitHub repositories of the local projects with Watch issues on, each once. */
    private async watchedRepositories(): Promise<string[]> {
        const agentless = this.deps.agentlessRemote ?? isRemoteProjectPath;
        const repositories = new Set<string>();
        for (const projectPath of this.deps.projects()) {
            if (!resolveWatchIssues(this.deps.settings.project(projectPath)) || agentless(projectPath)) continue;
            const root = await this.deps.git.worktreeRoot(projectPath);
            const origin = root ? await this.deps.remotes.originUrl(root) : null;
            const repository = origin ? gitHubRepository(origin) : '';
            if (repository) repositories.add(repository);
        }
        return [...repositories];
    }

    /** Fold one source's answer in and write it. */
    private sync(
        manager: InboxManager,
        source: string,
        fetched: readonly InboxFacts[],
        answer: Pick<SyncContext, 'complete' | 'viewer' | 'excluded'>,
    ): void {
        const now = this.deps.clock.now();
        let watchingSince = this.deps.store.watchingSince(source);
        if (watchingSince === null) {
            watchingSince = now;
            this.deps.store.setWatchingSince(source, now);
        }
        const known = [...this.items.values()].filter((item) => item.manager === manager && item.source === source);
        const result = syncSource(known, fetched, {
            ...answer,
            now,
            watchingSince,
            thresholds: this.deps.bugsnag.settings().trending,
        });
        const before = new Map(known.map((item) => [item.key, item]));
        const changed = result.items.filter((item) => !sameItem(before.get(item.key), item));
        this.commit(changed, result.removed);
    }

    /** Write a change, keep it, and tell the renderer. */
    private commit(save: readonly InboxItem[], remove: readonly string[]): void {
        const removing = remove.filter((key) => this.items.has(key));
        if (save.length === 0 && removing.length === 0) return;
        this.deps.store.apply(save, removing);
        for (const item of save) this.items.set(item.key, item);
        for (const key of removing) this.items.delete(key);
        this.deps.renderer.inboxChanged(this.summary());
    }
}

/** A project's open errors matching `query`, page by page up to the cap; `complete` when that was all. */
async function allErrors(
    api: BugsnagApi,
    projectId: string,
    query: ErrorQuery,
): Promise<{errors: BugsnagError[]; complete: boolean}> {
    const errors: BugsnagError[] = [];
    let page = await api.listErrors(projectId, {...query, status: 'open', perPage: ERRORS_PER_PAGE});
    errors.push(...page.errors);
    for (let pages = 1; page.next && pages < MAX_ERROR_PAGES; pages++) {
        page = await api.listErrors(projectId, {page: page.next});
        errors.push(...page.errors);
    }
    return {errors, complete: page.next === null};
}

/** Whether a sync left an item as it was: nothing to write. */
function sameItem(before: InboxItem | undefined, after: InboxItem): boolean {
    return before !== undefined && JSON.stringify(before) === JSON.stringify(after);
}
