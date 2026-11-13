/**
 * The Merge manager on a VM's agent (#438, #442, epic #432): what runs the
 * lanes and the fix errands with no Mac connected, while this VM is the
 * Merging host.
 *
 * The lanes are run by the same application services as on the Mac, wired
 * into the agent's composition root (`src/agent/parts.ts`): the Merge
 * manager (`MergeManagerService`), its Switchboard lane runner (`LaneRunner`)
 * and its fix errands (`FixErrandService`), over the VM's own `gh` login and
 * one lane state file (`LaneStateStore`). This part drives them:
 *
 * - **Only while merging.** `HostSettings.mergingHost` says whether this VM
 *   is the Merging host; nothing is read or run otherwise. Only one place
 *   merges at a time.
 * - **Ticks** every MERGE_TICK_MS: one poll of every lane, which updates,
 *   tests and merges the heads and starts the errands that are wanted.
 * - **Hearing errands with nobody at the Mac.** Turn ends from the hook
 *   forwarder's in-process listener and session ends from the session host's
 *   reach the errands, Mac or no Mac. An errand that asks a question is
 *   stopped: its PR goes to Needs you with the question (the CLI keeps
 *   asking in its terminal, so answering it from the Mac resumes it).
 * - **Recovery.** The sessions are the agent's own children, so a restart
 *   (crash, upgrade) ends every errand. On the first tick as Merging host the
 *   errands whose session is gone are forgotten, and the poll that follows
 *   starts a fresh one for each PR still at Fixing.
 * - **The Mac's calls** (`merge-call`): the lanes' state; `take` (the
 *   hand-off: the Mac's landed PRs, then merging here); `release` (bring
 *   back: the step under way finishes, never mid-merge, the errands stop and
 *   the landed PRs go back); `stand-down` (the Mac took merging back while
 *   this VM was away); and Land it, Unland and Try again, forwarded.
 *
 * An orderly shutdown (`start`'s stop) stops listening before the sessions
 * are terminated, so the errands ended by the shutdown are not read as
 * errands that gave up; recovery starts them again.
 */
import {deadErrands} from '../../../domain/agent/lane-state';
import type {HostSettings, MergeCallMessage, MergeCallMethod} from '../../../domain/agent/protocol';
import type {LandedPullRequest} from '../../../domain/merge-manager/model';
import type {ClientLink} from '../../ports/agent-link';
import type {TimerHandle, Timers} from '../../ports/clock';
import type {Logger} from '../../ports/logger';
import type {FixErrandService} from '../fix-errand-service';
import type {MergeManagerService} from '../merge-manager-service';
import type {MergePart} from './handlers';
import type {HookForwarder} from './hook-forwarder';
import type {LaneStateStore} from './lane-store';
import type {SessionHost} from './session-host';

/** How often the lanes are looked at while this VM merges, as on the Mac. */
export const MERGE_TICK_MS = 60_000;

export interface MergeHostDeps {
    manager: Pick<MergeManagerService, 'poll' | 'pause' | 'resume' | 'adopt' | 'all' | 'state' | 'land' | 'unland'>;
    errands: Pick<
        FixErrandService,
        'errands' | 'isErrand' | 'handOver' | 'turnEnded' | 'sessionEnded' | 'needsAttention' | 'tryAgain'
    >;
    store: Pick<LaneStateStore, 'current' | 'removeErrands' | 'byRepository' | 'setNoWorkflowScope'>;
    sessions: Pick<SessionHost, 'isAlive' | 'onExit' | 'stop'>;
    hooks: Pick<HookForwarder, 'subscribe'>;
    /** The host's settings now: `mergingHost` switches all of this on. */
    hostSettings: () => HostSettings;
    /** Save `mergingHost`, as a `set-host-settings` would. */
    setMerging(on: boolean): void;
    timers: Timers;
    log: Logger;
}

/** What `state` answers: the lanes as this VM runs them, for the Mac to show. */
export interface MergeHostState {
    merging: boolean;
    state: ReturnType<MergeManagerService['state']>;
    landed: LandedPullRequest[];
    errands: ReturnType<FixErrandService['errands']>;
    /** Savings since the `since` the Mac asked from, by lower-case repository. */
    savedByRepository: ReturnType<LaneStateStore['byRepository']>;
}

export class MergeHost implements MergePart {
    /** Whether recovery ran since this VM became the Merging host. */
    private recovered = false;
    private ticking: Promise<void> | null = null;
    private stopped = false;

    constructor(private readonly deps: MergeHostDeps) {
        deps.hooks.subscribe({
            turnEnded: (launchId) => {
                if (!this.stopped) deps.errands.turnEnded([launchId], false);
            },
            asked: (launchId, asked) => {
                if (this.stopped || !this.merging || !deps.errands.isErrand(launchId)) return false;
                deps.errands.needsAttention(launchId, asked.questions[0]?.question ?? null);
                return true;
            },
        });
        // A shutdown's own SIGTERM is not an errand giving up: keep it for recovery.
        deps.sessions.onExit((sessionId) => {
            if (!this.stopped) deps.errands.sessionEnded(sessionId);
        });
        if (!this.merging) void deps.manager.pause();
    }

    /** Whether this VM is the Merging host now. */
    public get merging(): boolean {
        return this.deps.hostSettings().mergingHost === true;
    }

    /** Tick now and every MERGE_TICK_MS; the returned function stops it (and stops listening). */
    public start(): () => void {
        this.stopped = false;
        const handle: TimerHandle = this.deps.timers.setInterval(() => void this.tick(), MERGE_TICK_MS);
        void this.tick();
        return () => {
            this.stopped = true;
            this.deps.timers.clearInterval(handle);
        };
    }

    /**
     * One pass: nothing unless this VM merges; recovery on the first pass as
     * Merging host; then every lane. Passes never overlap. Never throws.
     */
    public tick(): Promise<void> {
        if (this.stopped) return Promise.resolve();
        if (!this.merging) {
            this.recovered = false;
            return Promise.resolve();
        }
        this.ticking ??= this.pass().finally(() => (this.ticking = null));
        return this.ticking;
    }

    private async pass(): Promise<void> {
        try {
            if (!this.recovered) {
                this.recovered = true;
                this.recover();
            }
            this.deps.manager.resume();
            await this.deps.manager.poll();
        } catch (err) {
            this.deps.log.error('[merge-host] a pass failed', err);
        }
    }

    /** Errands whose session is gone (a restart ended them) are forgotten; the next poll starts fresh ones. */
    private recover(): void {
        const dead = deadErrands(this.deps.store.current(), (id) => this.deps.sessions.isAlive(id));
        if (dead.length === 0) return;
        this.deps.store.removeErrands(dead.map((errand) => errand.id));
        for (const errand of dead) {
            this.deps.log.info(`[merge-host] ${errand.key}'s errand ended with the agent; a fresh one starts`);
        }
    }

    // ── The Mac's calls ──

    public clientConnected(_client: ClientLink): void {}

    public clientGone(_client: ClientLink): void {}

    public handle(client: ClientLink, message: MergeCallMessage): void {
        const {requestId, method} = message;
        this.call(method, message.args).then(
            (result) => {
                if (!client.closed) client.send({type: 'merge-answer', requestId, ok: true, result: result ?? null});
            },
            (err: unknown) => {
                const error = err instanceof Error ? err.message : String(err);
                if (!client.closed) client.send({type: 'merge-answer', requestId, ok: false, error});
            },
        );
    }

    /** One call from the Mac; rejects with what to tell the user. */
    public async call(method: MergeCallMethod, args: Record<string, unknown>): Promise<unknown> {
        switch (method) {
            case 'state':
                return this.state(typeof args.since === 'number' ? args.since : 0);
            case 'take':
                return this.take(args);
            case 'release':
                return {landed: await this.release('merging was brought back to the Mac')};
            case 'stand-down':
                await this.release('the Mac took merging back');
                return {};
        }
        if (!this.merging) throw new Error('this VM is not the Merging host');
        const repository = typeof args.repository === 'string' ? args.repository : '';
        const number = typeof args.number === 'number' ? args.number : 0;
        if (!/^[^/\s]+\/[^/\s]+$/.test(repository) || !Number.isInteger(number) || number <= 0) {
            throw new Error('not a pull request');
        }
        switch (method) {
            case 'land':
                return this.deps.manager.land(repository, number);
            case 'unland':
                return this.deps.manager.unland(repository, number);
            case 'try-again':
                return this.deps.errands.tryAgain(repository, number, typeof args.note === 'string' ? args.note : null);
        }
    }

    private state(since: number): MergeHostState {
        return {
            merging: this.merging,
            state: this.deps.manager.state(),
            landed: this.deps.manager.all(),
            errands: this.deps.errands.errands(),
            savedByRepository: this.deps.store.byRepository(since),
        };
    }

    /**
     * The hand-off: the Mac's landed PRs replace what this VM kept, and it
     * becomes the Merging host. Errands left over from an earlier turn here
     * are let go first; the first pass starts fresh ones.
     */
    private take(args: Record<string, unknown>): {ok: true} {
        const landed = Array.isArray(args.landed) ? (args.landed as LandedPullRequest[]) : [];
        this.stopErrands();
        this.deps.store.setNoWorkflowScope(args.noWorkflowScope === true);
        this.deps.manager.adopt(landed);
        this.deps.setMerging(true);
        this.recovered = false;
        this.deps.log.info(`[merge-host] merging handed off here with ${landed.length} landed PR(s)`);
        void this.tick();
        return {ok: true};
    }

    /**
     * Stop merging: no new pass, the one under way finishes its step (never
     * mid-merge), the errands are let go and their sessions stopped. Answers
     * the landed PRs as they are now.
     */
    private async release(why: string): Promise<LandedPullRequest[]> {
        this.deps.setMerging(false);
        await this.ticking;
        await this.deps.manager.pause();
        this.stopErrands();
        this.deps.log.info(`[merge-host] stopped merging: ${why}`);
        return this.deps.manager.all();
    }

    private stopErrands(): void {
        for (const sessionId of this.deps.errands.handOver()) this.deps.sessions.stop(sessionId);
    }
}
