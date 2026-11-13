/**
 * The Merge manager on a VM's agent (#438, epic #432): what lets the agent run
 * lanes and fix errands with no Mac connected, while this VM is the Merging
 * host.
 *
 * It is wired into the agent's composition root (`src/agent/parts.ts`) the way
 * the host's schedules are, started once the agent listens and stopped on
 * shutdown, and does nothing unless the host's settings say this VM is the
 * Merging host (`HostSettings.mergingHost`, set by the hand-off, #442). Only
 * one place merges at a time.
 *
 * What it owns:
 * - **The lane state file** (LANE_STATE_FILE, `domain/agent/lane-state`):
 *   landed pull requests and which errand session belongs to which pull
 *   request. Everything else is read from GitHub again by the lane runner.
 * - **Fix errands as real sessions.** An errand is a Claude session the agent
 *   starts by itself (`SessionHost.startSelf`) in its own worktree, detached
 *   at `origin/<branch>`, in a copy of the repository the agent makes itself
 *   when it has none (`Copies.ensureCopy`). The Mac can attach to it later.
 * - **Hearing errands with nobody at the Mac.** Turn ends come from the hook
 *   forwarder's in-process listener, session ends from the session host's;
 *   both reach the lane runner whether or not a Mac is connected.
 * - **Recovery.** The sessions are the agent's own children, so a restart
 *   (crash, upgrade) ends every errand. On the first tick as Merging host the
 *   file is read and each errand whose session is gone gets a fresh session
 *   if its pull request is still landed, or is forgotten if not.
 *
 * The lane runner itself (update, test and merge the head: #435) plugs in as
 * the `runner` port and is ticked every 60 s while this VM merges.
 *
 * An orderly shutdown (`stop`) stops listening before the sessions are
 * terminated, so the errands ended by the shutdown stay in the file and are
 * recovered on the next start, rather than being taken for errands that
 * finished.
 */
import {
    errandOfSession,
    landPr,
    laneOrder,
    parseLaneState,
    recoveryPlan,
    samePr,
    serializeLaneState,
    unlandPr,
    withErrand,
    withoutErrandSession,
    type LandedPr,
    type LaneErrand,
    type LanePrRef,
    type LaneState,
} from '../../../domain/agent/lane-state';
import type {HostSettings} from '../../../domain/agent/protocol';
import type {SessionOptions} from '../../../domain/launch/session-options';
import type {Clock, TimerHandle, Timers} from '../../ports/clock';
import type {IdGenerator} from '../../ports/ids';
import type {Logger} from '../../ports/logger';
import type {RecordFile} from '../../ports/record-file';
import type {Copies} from './copies';
import type {HookForwarder} from './hook-forwarder';
import type {SessionHost} from './session-host';

/** How often the lanes are looked at while this VM merges, as on the Mac. */
export const MERGE_TICK_MS = 60_000;

/** The lane runner (#435), as the agent's Merge manager drives it. */
export interface LaneRunner {
    /** One pass over the lanes; called every MERGE_TICK_MS while this VM is the Merging host. */
    tick(): Promise<void>;
    /** An errand's session ended its turn. */
    errandTurnEnded?(errand: LaneErrand): void;
    /** An errand's session ended; it is no longer in the lane state. */
    errandEnded?(errand: LaneErrand, exitCode: number): void;
}

/** What a fix errand is started on. */
export interface ErrandRequest extends LanePrRef {
    branch: string;
    /** The errand's whole first prompt (#437 builds it). */
    prompt: string;
}

export type ErrandStart = {ok: true; errand: LaneErrand} | {ok: false; error: string};

export interface MergeHostDeps {
    laneFile: RecordFile;
    sessions: Pick<SessionHost, 'startSelf' | 'isAlive' | 'onExit'>;
    hooks: Pick<HookForwarder, 'subscribe'>;
    copies: Pick<Copies, 'ensureCopy' | 'errandWorktree'>;
    /** The host's settings now: `mergingHost` switches all of this on. */
    hostSettings: () => HostSettings;
    ids: IdGenerator;
    clock: Clock;
    timers: Timers;
    log: Logger;
    /** The lane runner; absent until #435 wires it, and then only errands and recovery run. */
    runner?: LaneRunner;
}

/** The launch options of an errand's session: auto mode, starting on its prompt. */
export function errandOptions(prompt: string): SessionOptions {
    return {permissionMode: 'auto', initialPrompt: prompt};
}

/** The prompt a recovered errand starts on: its old one, and why it starts again. */
export function recoveredPrompt(errand: LaneErrand): string {
    return (
        `${errand.prompt}\n\n` +
        `An earlier errand session for this pull request ended when the Switchboard agent restarted. ` +
        `This is a fresh worktree at origin/${errand.branch}; anything it pushed is here, anything it did not push is gone.`
    );
}

export class MergeHost {
    private state: LaneState | null = null;
    /** Whether recovery ran since this VM became the Merging host. */
    private recovered = false;
    private ticking = false;
    private stopped = false;
    /** Pull requests whose errand is being started, so a second start waits its turn rather than doubling it. */
    private readonly starting = new Set<string>();

    constructor(private readonly deps: MergeHostDeps) {
        deps.hooks.subscribe({turnEnded: (launchId) => this.turnEnded(launchId)});
        deps.sessions.onExit((sessionId, exitCode) => this.exited(sessionId, exitCode));
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
     * Merging host; then the lane runner. Passes never overlap. Never throws.
     */
    public async tick(): Promise<void> {
        if (this.stopped || this.ticking) return;
        if (!this.merging) {
            this.recovered = false;
            return;
        }
        this.ticking = true;
        try {
            if (!this.recovered) {
                this.recovered = true;
                await this.recover();
            }
            await this.deps.runner?.tick();
        } catch (err) {
            this.deps.log.error('[merge-host] a pass failed', err);
        } finally {
            this.ticking = false;
        }
    }

    /** The lane state as it is now. */
    public current(): LaneState {
        this.state ??= parseLaneState(this.deps.laneFile.read());
        return this.state;
    }

    /** A repository's landed pull requests, in land order. */
    public lane(repo: string): LandedPr[] {
        return laneOrder(this.current(), repo);
    }

    /** Land a pull request in its Switchboard lane; already landed keeps its place. */
    public land(pr: LandedPr): void {
        this.save(landPr(this.current(), pr));
    }

    /** Take a pull request out of its lane; its errand's session, if any, runs on unowned. */
    public unland(pr: LanePrRef): void {
        this.save(unlandPr(this.current(), pr));
    }

    /**
     * Start a fix errand for a landed pull request: a copy of its repository
     * (made if the VM has none), a worktree detached at `origin/<branch>`, and
     * a Claude session the agent starts by itself in it, recorded as the pull
     * request's errand. An errand already running for it is refused.
     */
    public async startErrand(request: ErrandRequest): Promise<ErrandStart> {
        const key = `${request.repo.toLowerCase()}#${request.number}`;
        const running = this.current().errands.find((errand) => samePr(errand, request));
        if (running && this.deps.sessions.isAlive(running.sessionId)) {
            return {ok: false, error: `#${request.number} already has an errand (session ${running.sessionId})`};
        }
        if (this.starting.has(key)) return {ok: false, error: `#${request.number}'s errand is already starting`};
        this.starting.add(key);
        try {
            return await this.launchErrand(request);
        } finally {
            this.starting.delete(key);
        }
    }

    private async launchErrand(request: ErrandRequest): Promise<ErrandStart> {
        const {copies, sessions, ids, clock, log} = this.deps;
        const name = request.repo.split('/')[1] ?? request.repo;
        const copy = await copies.ensureCopy({
            name,
            origin: `https://github.com/${request.repo}.git`,
            github: request.repo,
        });
        if (!copy.ok) return copy;

        const sessionId = ids.newId();
        const worktree = await copies.errandWorktree(
            copy.abs,
            request.branch,
            `errand-${request.number}-${sessionId.slice(0, 8)}`,
        );
        if (!worktree.ok) return worktree;

        const started = await sessions.startSelf({
            sessionId,
            dir: worktree.abs,
            options: errandOptions(request.prompt),
            errand: true,
        });
        if (!started.ok) return started;

        const errand: LaneErrand = {
            repo: request.repo,
            number: request.number,
            branch: request.branch,
            sessionId,
            dir: worktree.abs,
            prompt: request.prompt,
            startedAt: clock.now(),
        };
        this.save(withErrand(this.current(), errand));
        log.info(`[merge-host] errand for ${request.repo}#${request.number} started as session=${sessionId}`);
        return {ok: true, errand};
    }

    /**
     * After a restart, or when this VM becomes the Merging host: errands whose
     * session is gone start again if their pull request is still landed, and
     * are forgotten if not. One that cannot start again is forgotten and
     * logged; the lane runner sees its pull request still stuck and decides.
     */
    private async recover(): Promise<void> {
        const plan = recoveryPlan(this.current(), (sessionId) => this.deps.sessions.isAlive(sessionId));
        for (const errand of plan.drop) {
            this.save(withoutErrandSession(this.current(), errand.sessionId));
            this.deps.log.info(`[merge-host] ${errand.repo}#${errand.number} is no longer landed; forgot its errand`);
        }
        for (const errand of plan.restart) {
            this.save(withoutErrandSession(this.current(), errand.sessionId));
            const started = await this.startErrand({...errand, prompt: recoveredPrompt(errand)});
            if (started.ok) {
                this.deps.log.info(`[merge-host] recovered the errand for ${errand.repo}#${errand.number}`);
            } else {
                this.deps.log.warn(
                    `[merge-host] could not recover the errand for ${errand.repo}#${errand.number}: ${started.error}`,
                );
            }
        }
    }

    private turnEnded(launchId: string): void {
        if (this.stopped) return;
        const errand = errandOfSession(this.current(), launchId);
        if (errand) this.deps.runner?.errandTurnEnded?.(errand);
    }

    /** An errand's session ended for good: no longer owned, and the runner is told. */
    private exited(sessionId: string, exitCode: number): void {
        // A shutdown's own SIGTERM is not an errand finishing: keep it for recovery.
        if (this.stopped) return;
        const errand = errandOfSession(this.current(), sessionId);
        if (!errand) return;
        this.save(withoutErrandSession(this.current(), sessionId));
        this.deps.log.info(`[merge-host] errand for ${errand.repo}#${errand.number} ended (exit ${exitCode})`);
        this.deps.runner?.errandEnded?.(errand, exitCode);
    }

    /** Keep the state and write it whole; a failed write is logged and the state held for this run. */
    private save(next: LaneState): void {
        if (next === this.state) return;
        this.state = next;
        try {
            this.deps.laneFile.write(serializeLaneState(next));
        } catch (err) {
            this.deps.log.error('[merge-host] could not save the lane state', err);
        }
    }
}
