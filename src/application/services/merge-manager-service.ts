/**
 * The Merge manager's core (#434, for #432): which PRs are landed, the lane
 * each waits in, the stage each is at, and Land and Unland. The lane runner
 * that updates and merges a Switchboard lane's head (#435) and the fix
 * errands (#437) build on it.
 *
 * **Polling.** Once a minute, when the window gets focus, and once at start:
 *
 * 1. one search for the user's open PRs carrying a queue label, wherever it
 *    was added (`queuedPullRequests`);
 * 2. per repository with a landed or queued PR, its lane kind, from its
 *    workflow files and kept `LANE_KIND_RECHECK_MS` (`laneKind`);
 * 3. per repository, one slim read of its landed PRs only, with the trunk and
 *    its rules (`laneRead`), folded in by the domain (`syncLane`).
 *
 * A repository that could not be read keeps what it had. Merged PRs are not
 * read again, and go `MERGED_KEPT_MS` after they merged. Every change is
 * written at once and pushed to the renderer (`mergeManagerChanged`) when the
 * state it shows changed.
 *
 * **Land** writes the queue's label in a queue lane and nothing in a
 * Switchboard lane, takes `autorebase:opt-in` off in both, and places the PR
 * in its lane from the same read. **Unland** takes the queue's labels off in
 * a queue lane and drops the PR in both; running CI and errands are left alone.
 *
 * Nothing here notifies: the Merge manager's page, its figure and the Dock
 * show what happened (#439, #440). Whoever needs to act on a PR merging or
 * going to Needs you hears it through `onTransitions` (#440): the Dock's one
 * bounce, and archiving a merged PR's session.
 */
import {laneKindOf} from '../../domain/merge-manager/lane-kind';
import {
    expiredMerged,
    landLabels,
    landRefusal,
    landed,
    landedView,
    mergeManagerState,
    setAside,
    syncLane,
    unlandLabels,
} from '../../domain/merge-manager/landed';
import {landedKey} from '../../domain/merge-manager/model';
import {landedTransitions, type LandedTransitions} from '../../domain/merge-manager/transitions';
import type {
    LandedPullRequest,
    LandedView,
    LaneKind,
    LaneRead,
    MergeManagerState,
    SetAside,
    TrunkRules,
} from '../../domain/merge-manager/model';
import type {Clock, TimerHandle, Timers} from '../ports/clock';
import type {GitHubCli, GitHubWrite, LaneReads, QueueLabelWrites} from '../ports/github-cli';
import type {LandedStore} from '../ports/landed-store';
import type {Logger} from '../ports/logger';
import type {RendererGateway} from '../ports/renderer-gateway';

/** How often the lanes are read. */
export const MERGE_MANAGER_INTERVAL_MS = 60_000;

/** How long a repository's lane kind is trusted before its workflows are read again. */
export const LANE_KIND_RECHECK_MS = 15 * 60_000;

export interface MergeManagerServiceDeps {
    store: LandedStore;
    github: Pick<GitHubCli, LaneReads | QueueLabelWrites>;
    renderer: Pick<RendererGateway, 'mergeManagerChanged'>;
    clock: Clock;
    timers: Timers;
    log: Logger;
}

/** Land's answer: the PR in its lane, place and all, or why it did not land. */
export type LandResult = {ok: true; landed: LandedView} | {ok: false; reason: string};

export class MergeManagerService {
    private readonly landed = new Map<string, LandedPullRequest>();
    /** Each repository's lane kind (by lower-case `owner/repo`), and when it was read. */
    private readonly kinds = new Map<string, {kind: LaneKind; at: number}>();
    /** Each repository's trunk rules, as last read. */
    private readonly rules = new Map<string, TrunkRules>();
    private interval: TimerHandle | null = null;
    private polling: Promise<void> | null = null;
    /** A poll asked for while one ran: run once more after it. */
    private again = false;
    /** What was last pushed. */
    private published: string | null = null;
    private readonly followers: Array<(transitions: LandedTransitions) => void> = [];

    constructor(private readonly deps: MergeManagerServiceDeps) {
        for (const pr of deps.store.all()) this.landed.set(pr.key, pr);
    }

    /** Poll now and every minute after. */
    public start(): void {
        if (this.interval) return;
        this.interval = this.deps.timers.setInterval(() => void this.poll(), MERGE_MANAGER_INTERVAL_MS);
        void this.poll();
    }

    public stop(): void {
        this.deps.timers.clearInterval(this.interval);
        this.interval = null;
    }

    /** The window got focus: poll once more, when polling is on. */
    public focused(): void {
        if (this.interval) void this.poll();
    }

    /** Read every lane once. A poll asked for while one runs runs once more after it. */
    public poll(): Promise<void> {
        if (this.polling) {
            this.again = true;
            return this.polling;
        }
        this.polling = this.pollAll()
            .catch((err) => this.deps.log.error('[merge-manager] polling failed:', (err as Error).message))
            .finally(() => {
                this.polling = null;
                if (this.again) {
                    this.again = false;
                    void this.poll();
                }
            });
        return this.polling;
    }

    /**
     * Hear each change that merged a landed PR or sent one to Needs you. PRs
     * already there when the app starts are not told again.
     */
    public onTransitions(fn: (transitions: LandedTransitions) => void): void {
        this.followers.push(fn);
    }

    /** Every lane with a landed PR, and how many need you. */
    public state(): MergeManagerState {
        return mergeManagerState([...this.landed.values()], this.rules);
    }

    /** A landed PR, or null when it is not landed. */
    public pullRequest(repository: string, number: number): LandedPullRequest | null {
        return this.landed.get(landedKey(repository, number)) ?? null;
    }

    /**
     * A repository's lane kind, from its workflow files, read again after
     * `LANE_KIND_RECHECK_MS`. When they cannot be read the last kind stands;
     * null when there is none.
     */
    public async laneKind(repository: string): Promise<LaneKind | null> {
        const id = repository.toLowerCase();
        const known = this.kinds.get(id);
        const now = this.deps.clock.now();
        if (known && now - known.at < LANE_KIND_RECHECK_MS) return known.kind;
        const files = await this.deps.github.workflowFiles(repository).catch(() => null);
        if (!files) return known?.kind ?? null;
        const kind = laneKindOf(files);
        this.kinds.set(id, {kind, at: now});
        return kind;
    }

    // ── Land and Unland ──

    /** Hand a PR to the Merge manager. Landing a landed PR again answers it as it is. */
    public async land(repository: string, number: number): Promise<LandResult> {
        const key = landedKey(repository, number);
        const kind = await this.laneKind(repository);
        if (!kind) return {ok: false, reason: 'GitHub could not be asked which lane it is in'};
        // The lane's other PRs too, so it is placed among them.
        const read = await this.read(repository, [number]);
        const pr = read?.pullRequests.find((candidate) => candidate.number === number);
        if (!read || !pr) return {ok: false, reason: `#${number} could not be read from GitHub`};
        const known = this.landed.get(key);
        if (!known || known.stage.kind === 'merged') {
            const refusal = landRefusal(pr, read.viewer);
            if (refusal) return {ok: false, reason: refusal};
        }

        const labels = landLabels(pr, kind);
        for (const label of labels.add) {
            const write = await this.deps.github.addLabel(read.repository, number, label);
            if (!write.ok) return {ok: false, reason: write.reason};
        }
        for (const label of labels.remove) {
            const write = await this.deps.github.removeLabel(read.repository, number, label);
            if (!write.ok) this.deps.log.warn(`[merge-manager] ${key}: ${label} not removed:`, write.reason);
        }

        const written = new Set([...pr.labels.filter((label) => !labels.remove.includes(label)), ...labels.add]);
        const placed = {
            ...read,
            pullRequests: read.pullRequests.map((p) => (p === pr ? {...p, labels: [...written]} : p)),
        };
        const newcomer = known && known.stage.kind !== 'merged' ? [] : [landed(pr, kind, this.deps.clock.now())];
        this.fold(read.repository, placed, kind, newcomer);
        this.publish();
        const view = landedView(this.state(), key);
        return view ? {ok: true, landed: view} : {ok: false, reason: `#${number} did not land`};
    }

    /** Take a PR back. In a queue lane the queue's labels come off first; a PR that is not landed is left be. */
    public async unland(repository: string, number: number): Promise<GitHubWrite> {
        const key = landedKey(repository, number);
        const known = this.landed.get(key);
        if (!known) return {ok: true};
        if (known.lane === 'queue' && known.stage.kind !== 'merged') {
            const read = await this.deps.github.laneRead(known.repository, [number]);
            const pr = read?.pullRequests.find((candidate) => candidate.number === number);
            if (!pr) return {ok: false, reason: `#${number} could not be read from GitHub`};
            for (const label of unlandLabels(pr, 'queue')) {
                const write = await this.deps.github.removeLabel(known.repository, number, label);
                if (!write.ok) return write;
            }
        }
        this.commit([], [key]);
        this.publish();
        // The Switchboard lane's next PR up becomes the head.
        if (known.lane === 'switchboard') void this.poll();
        return {ok: true};
    }

    // ── For the lane runner and the fix errands (#435, #437) ──

    /** Set a landed PR aside (Fixing, Needs you) on a commit, or clear it (null). Null for a PR that is not landed. */
    public setAside(key: string, aside: SetAside | null): LandedPullRequest | null {
        return this.change(key, (pr) => setAside(pr, aside));
    }

    /** Link the fix errand's session working on a landed PR, or unlink it (null). */
    public linkErrand(key: string, sessionId: string | null): LandedPullRequest | null {
        return this.change(key, (pr) => ({...pr, errand: sessionId}));
    }

    private change(key: string, apply: (pr: LandedPullRequest) => LandedPullRequest): LandedPullRequest | null {
        const before = this.landed.get(key);
        if (!before) return null;
        const after = apply(before);
        this.commit([after], []);
        this.publish();
        return after;
    }

    // ── Polling ──

    private async pollAll(): Promise<void> {
        const queued = await this.deps.github.queuedPullRequests().catch(() => null);
        if (!queued) this.deps.log.warn('[merge-manager] your queued pull requests not read');

        const repositories = new Map<string, {repository: string; queued: number[]}>();
        const add = (repository: string, number: number | null): void => {
            const id = repository.toLowerCase();
            const entry = repositories.get(id) ?? {repository, queued: []};
            if (number !== null) entry.queued.push(number);
            repositories.set(id, entry);
        };
        for (const pr of this.landed.values()) if (pr.stage.kind !== 'merged') add(pr.repository, null);
        for (const pr of queued ?? []) add(pr.repository, pr.number);

        for (const {repository, queued: labelled} of repositories.values()) {
            const kind = await this.laneKind(repository);
            if (!kind) {
                this.deps.log.warn(`[merge-manager] lane kind of ${repository} not read`);
                continue;
            }
            // A queue label means nothing in a Switchboard lane.
            const read = await this.read(repository, kind === 'queue' ? labelled : []);
            if (read === undefined) continue;
            if (!read) {
                this.deps.log.warn(`[merge-manager] lane of ${repository} not read`);
                continue;
            }
            this.fold(repository, read, kind, []);
        }

        const now = this.deps.clock.now();
        this.commit([], expiredMerged([...this.landed.values()], now));
        this.publish();
    }

    /**
     * One repository's lane read: its unmerged landed PRs and `extra`.
     * Undefined when there is nothing to read; null when it could not be read.
     */
    private async read(repository: string, extra: readonly number[]): Promise<LaneRead | null | undefined> {
        const numbers = new Set(extra);
        for (const pr of this.inRepository(repository)) if (pr.stage.kind !== 'merged') numbers.add(pr.number);
        if (numbers.size === 0) return undefined;
        const read = await this.deps.github.laneRead(repository, [...numbers]).catch(() => null);
        if (read) this.rules.set(repository.toLowerCase(), read.rules);
        return read;
    }

    /** Fold a lane read into its repository's landed PRs, with `newcomers` just landed. */
    private fold(repository: string, read: LaneRead, kind: LaneKind, newcomers: readonly LandedPullRequest[]): void {
        const known = [
            ...this.inRepository(repository).filter((pr) => !newcomers.some((n) => n.key === pr.key)),
            ...newcomers,
        ];
        const sync = syncLane(known, read, kind, this.deps.clock.now());
        const changed = sync.landed.filter((pr) => JSON.stringify(this.landed.get(pr.key)) !== JSON.stringify(pr));
        this.commit(changed, sync.removed);
    }

    private inRepository(repository: string): LandedPullRequest[] {
        const id = repository.toLowerCase();
        return [...this.landed.values()].filter((pr) => pr.repository.toLowerCase() === id);
    }

    /** Write a change and keep it. */
    private commit(save: readonly LandedPullRequest[], remove: readonly string[]): void {
        const removing = remove.filter((key) => this.landed.has(key));
        if (save.length === 0 && removing.length === 0) return;
        const transitions = landedTransitions(this.landed, save);
        this.deps.store.apply(save, removing);
        for (const pr of save) this.landed.set(pr.key, pr);
        for (const key of removing) this.landed.delete(key);
        if (transitions.merged.length === 0 && transitions.needsYou.length === 0) return;
        for (const fn of this.followers) {
            try {
                fn(transitions);
            } catch (err) {
                this.deps.log.error('[merge-manager] a transition follower failed:', (err as Error).message);
            }
        }
    }

    /** Push the state when what it shows changed. */
    private publish(): void {
        const state = this.state();
        const signature = JSON.stringify(state);
        if (signature === this.published) return;
        this.published = signature;
        this.deps.renderer.mergeManagerChanged(state);
    }
}
