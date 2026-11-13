/**
 * The Switchboard lane runner (#435, for #432): updates, tests and merges the
 * head of each Switchboard lane, with as few CI runs as possible.
 *
 * The Merge manager hands it a lane after every poll has placed its PRs
 * (`MergeManagerService`); what to do is decided in the domain
 * (`domain/merge-manager/runner.ts`) and carried out here, as the user, through
 * `gh`:
 *
 * - the head is rebased onto the trunk (`updateBranch`, pinned to its head
 *   commit), or its cancelled runs started again;
 * - a green head is merged (`mergePullRequest`, pinned to the green commit);
 * - runs of PRs waiting behind the head are cancelled, force-cancelled when
 *   that did not stop them;
 * - a waiting PR GitHub calls `dirty` is test-rebased (`TestRebase`), never
 *   pushed.
 *
 * A pass answers what the Merge manager must fold in: PRs set aside (Fixing on
 * a conflict, Needs you on a refusal), and whether to read the lane again at
 * once (it merged, or a head moved). Every saving is counted (`LaneSavings`).
 *
 * What it remembers between passes (updates asked for, runs cancelled, test
 * rebases) is kept in memory: after a restart an update may be asked for
 * again, which the pinned head commit makes harmless.
 */
import {
    EMPTY_MEMORY,
    afterMerge,
    afterUpdate,
    confirmedConflicts,
    laneActions,
    updatesNotPushed,
    type FollowUp,
    type LaneAction,
    type LaneInput,
    type RunnerMemory,
    type TestRebaseResult,
} from '../../domain/merge-manager/runner';
import {landedKey, LANE_SAVINGS} from '../../domain/merge-manager/model';
import type {LandedPullRequest, LaneRead, LaneSaving, SetAside} from '../../domain/merge-manager/model';
import type {Clock} from '../ports/clock';
import type {GitHubCli, LaneWrites} from '../ports/github-cli';
import type {LaneSavings} from '../ports/lane-savings';
import type {Logger} from '../ports/logger';
import type {TestRebase} from '../ports/test-rebase';

/** How long a cancelled run is remembered: long past any run that could still be going. */
const FORGET_RUNS_AFTER_MS = 24 * 60 * 60_000;

export interface LaneRunnerDeps {
    github: Pick<GitHubCli, LaneWrites>;
    testRebase: TestRebase;
    savings: LaneSavings;
    clock: Clock;
    log: Logger;
}

/** What a pass asks the Merge manager to fold in. */
export interface LanePass {
    /** PRs set aside on the commit they were at. */
    readonly asides: readonly {readonly key: string; readonly aside: SetAside}[];
    /** Whether a test rebase found something new, so the lane's stages are placed again. */
    readonly conflictsChanged: boolean;
    /** Read the lane again at once: a PR merged, or a head moved. */
    readonly reread: boolean;
}

export class LaneRunner {
    private memory: {
        updated: Map<string, {headOid: string; at: number}>;
        rerun: Set<number>;
        cancelled: Map<number, {at: number; forced: boolean}>;
        testRebases: Map<string, TestRebaseResult>;
        spared: Map<string, string>;
    } = {
        updated: new Map(EMPTY_MEMORY.updated),
        rerun: new Set(EMPTY_MEMORY.rerun),
        cancelled: new Map(EMPTY_MEMORY.cancelled),
        testRebases: new Map(EMPTY_MEMORY.testRebases),
        spared: new Map(EMPTY_MEMORY.spared),
    };
    /** Each lane's trunk commit as last seen, by lower-case repository. */
    private readonly trunks = new Map<string, string>();
    /** Repositories warned about rules that drop an approval on push. */
    private readonly warned = new Set<string>();

    constructor(private readonly deps: LaneRunnerDeps) {}

    /** What test rebases found of this lane's waiting PRs at the commits it was read at. */
    public conflicts(read: LaneRead): Map<string, boolean> {
        return confirmedConflicts(
            read.pullRequests,
            (pr) => landedKey(pr.repository, pr.number),
            read.trunkOid,
            this.remembered(),
        );
    }

    /**
     * A fix errand ran a PR's failed runs again on `headOid` (#437): leave
     * those runs be while it waits behind the head, rather than cancel them.
     */
    public spare(key: string, headOid: string): void {
        this.memory.spared.set(key, headOid);
    }

    /** CI runs saved since `at`, by kind. */
    public saved(at: number): Record<LaneSaving, number> {
        return this.deps.savings.since(at);
    }

    /** One pass over a Switchboard lane: its read, and its landed PRs as the poll just placed them. */
    public async run(read: LaneRead, landed: readonly LandedPullRequest[]): Promise<LanePass> {
        const now = this.deps.clock.now();
        const reads = new Map(read.pullRequests.map((pr) => [landedKey(pr.repository, pr.number), pr]));
        const entries = landed
            .filter((pr) => pr.stage.kind !== 'merged' && reads.has(pr.key))
            .map((pr) => ({landed: pr, read: reads.get(pr.key)!}));
        const lane: LaneInput = {
            entries,
            trunkOid: read.trunkOid,
            rules: read.rules,
            mergeMethods: read.mergeMethods,
            now,
        };
        this.countTrunkMove(read, entries);
        this.warnAboutApprovals(read);
        this.forget(
            entries.map(({landed: pr}) => pr.key),
            now,
        );

        const asides: {key: string; aside: SetAside}[] = [];
        let reread = false;
        let conflictsChanged = false;
        for (const action of laneActions(lane, this.remembered())) {
            const entry = entries.find(({landed: pr}) => pr.key === action.key)!;
            if (action.kind === 'testRebase') {
                if (await this.testRebase(read, action, entry.read.number)) conflictsChanged = true;
                continue;
            }
            const follow = await this.act(read, action, entry.read.number);
            switch (follow.kind) {
                case 'reread':
                    reread = true;
                    break;
                case 'fixing':
                    asides.push({
                        key: action.key,
                        aside: {kind: 'fixing', cause: follow.cause, reason: null, headOid: entry.read.headOid},
                    });
                    break;
                case 'needsYou':
                    asides.push({
                        key: action.key,
                        aside: {kind: 'needsYou', cause: null, reason: follow.reason, headOid: entry.read.headOid},
                    });
                    break;
                case 'update':
                case 'wait':
                    break;
            }
        }
        return {asides, conflictsChanged, reread};
    }

    /** Carry out one action; what follows from GitHub's answer. */
    private async act(
        read: LaneRead,
        action: Exclude<LaneAction, {kind: 'testRebase'}>,
        number: number,
    ): Promise<FollowUp> {
        const {github, log, clock} = this.deps;
        const repository = read.repository;
        const name = `${repository}#${number}`;
        switch (action.kind) {
            case 'update':
                return this.update(name, action.key, action.pullRequestId, action.headOid);
            case 'rerun': {
                for (const runId of action.runIds) {
                    const write = await github.rerunFailedJobs(repository, runId);
                    if (write.ok) this.memory.rerun.add(runId);
                    else log.warn(`[lane-runner] ${name}: run ${runId} not started again:`, write.reason);
                }
                log.info(`[lane-runner] ${name}: started its cancelled runs again`);
                return {kind: 'wait'};
            }
            case 'merge': {
                const answer = await github.mergePullRequest(repository, number, action.sha, action.method);
                const follow = afterMerge(answer);
                if (answer.ok) log.info(`[lane-runner] ${name} merged (${action.method}) at ${action.sha}`);
                else log.warn(`[lane-runner] ${name} not merged (${answer.status ?? 'no status'}):`, answer.reason);
                // Not mergeable now: behind the trunk again, so bring it up to date.
                if (follow.kind === 'update') {
                    const pr = read.pullRequests.find((candidate) => candidate.number === number);
                    return pr ? this.update(name, action.key, pr.id, action.sha, true) : {kind: 'reread'};
                }
                return follow;
            }
            case 'needsYou':
                log.warn(`[lane-runner] ${name} needs you:`, JSON.stringify(action.reason));
                return {kind: 'needsYou', reason: action.reason};
            case 'cancel': {
                const write = action.force
                    ? await github.forceCancelRun(repository, action.runId)
                    : await github.cancelRun(repository, action.runId);
                if (!write.ok) {
                    log.warn(`[lane-runner] ${name}: run ${action.runId} not cancelled:`, write.reason);
                    return {kind: 'wait'};
                }
                if (action.force) {
                    const cancelled = this.memory.cancelled.get(action.runId);
                    if (cancelled) this.memory.cancelled.set(action.runId, {...cancelled, forced: true});
                } else {
                    this.memory.cancelled.set(action.runId, {at: clock.now(), forced: false});
                    this.count(repository, 'run-cancelled', 1);
                }
                log.info(`[lane-runner] ${name}: ${action.force ? 'force-' : ''}cancelled run ${action.runId}`);
                return {kind: 'wait'};
            }
        }
    }

    /** Test-rebase a waiting PR; whether it was tried (and so its flag may change). */
    private async testRebase(
        read: LaneRead,
        action: Extract<LaneAction, {kind: 'testRebase'}>,
        number: number,
    ): Promise<boolean> {
        const name = `${read.repository}#${number}`;
        const answer = await this.deps.testRebase.conflicts(read.repository, read.trunk, action.branch);
        if (!answer) {
            this.deps.log.warn(`[lane-runner] ${name}: test rebase onto ${read.trunk} could not run`);
            return false;
        }
        this.memory.testRebases.set(action.key, {
            headOid: action.headOid,
            trunkOid: read.trunkOid,
            conflict: answer.conflict,
            files: answer.files,
        });
        if (answer.conflict) {
            this.count(read.repository, 'conflict-found', 1);
            this.deps.log.info(`[lane-runner] ${name} will conflict with ${read.trunk}:`, answer.files.join(', '));
        }
        return true;
    }

    /** Rebase the head onto the trunk, pinned to `headOid`. `again` after a 405, whatever was asked before. */
    private async update(
        name: string,
        key: string,
        pullRequestId: string,
        headOid: string,
        again = false,
    ): Promise<FollowUp> {
        const answer = await this.deps.github.updateBranch(pullRequestId, headOid);
        const follow = afterUpdate(answer);
        if (answer.ok) {
            this.memory.updated.set(key, {headOid, at: this.deps.clock.now()});
            this.deps.log.info(`[lane-runner] ${name}: ${again ? 'updated again' : 'updated'} from ${headOid}`);
        } else {
            this.deps.log.warn(`[lane-runner] ${name} not updated (${answer.why}):`, answer.reason);
        }
        return follow;
    }

    /** When the trunk moved, every PR waiting behind the head kept its CI: count the updates not pushed. */
    private countTrunkMove(read: LaneRead, entries: LaneInput['entries']): void {
        const id = read.repository.toLowerCase();
        const previous = this.trunks.get(id) ?? null;
        if (read.trunkOid) this.trunks.set(id, read.trunkOid);
        const saved = updatesNotPushed(previous, read.trunkOid, entries);
        if (saved > 0) this.count(read.repository, 'update-not-pushed', saved);
    }

    private warnAboutApprovals(read: LaneRead): void {
        const id = read.repository.toLowerCase();
        if (!read.rules.approvalLostOnPush || this.warned.has(id)) return;
        this.warned.add(id);
        this.deps.log.warn(
            `[lane-runner] ${read.repository}'s rules dismiss or block an approval on push: an updated head goes back to Held`,
        );
    }

    /** Drop what is remembered of PRs that left the lane, and of runs cancelled long ago. */
    private forget(keys: readonly string[], now: number): void {
        const open = new Set(keys);
        for (const [runId, cancelled] of [...this.memory.cancelled]) {
            if (now - cancelled.at > FORGET_RUNS_AFTER_MS) this.memory.cancelled.delete(runId);
        }
        for (const key of [...this.memory.updated.keys()]) if (!open.has(key)) this.memory.updated.delete(key);
        for (const key of [...this.memory.testRebases.keys()]) if (!open.has(key)) this.memory.testRebases.delete(key);
        for (const key of [...this.memory.spared.keys()]) if (!open.has(key)) this.memory.spared.delete(key);
    }

    private count(repository: string, kind: LaneSaving, count: number): void {
        if (!LANE_SAVINGS.includes(kind) || count <= 0) return;
        try {
            this.deps.savings.add(repository, kind, count, this.deps.clock.now());
        } catch (err) {
            this.deps.log.warn('[lane-runner] a saving was not counted:', (err as Error).message);
        }
    }

    private remembered(): RunnerMemory {
        return this.memory;
    }
}
