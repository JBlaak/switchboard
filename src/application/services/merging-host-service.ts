/**
 * The Mac's side of the Merging host (#442, decisions #429, epic #432): where
 * the Merge manager runs, this Mac or one VM, and moving it between them.
 * The rules are `domain/merge-manager/merging-host`; this is their plumbing.
 *
 * Everything the renderer asks of the Merge manager comes through here, so
 * it answers from whichever host merges:
 * - **On this Mac** the local `MergeManagerService` runs the lanes and the fix
 *   errands, and its state is shown as it is.
 * - **On a VM** the local one is paused and its errands handed over; the
 *   VM's agent runs the same services. Its lanes are read every minute and
 *   on focus (`merge-call state`) and shown with a "Merging on <VM>" badge and
 *   the away summary; Land it, Unland and Try again are forwarded to it.
 *   Merges and PRs going to Needs you seen in its reads are told to the same
 *   followers as the local ones (the Dock's bounce, archive on merge).
 *
 * **Hand off** checks the VM's `gh auth status` first: no login refuses with
 * the fix, no `workflow` scope warns. Then the local runner stops (the step
 * under way finishes), its running errands are forgotten and stopped, and
 * the landed PRs go to the VM (`take`). **Bring back** asks the VM to finish
 * its step, stop its errands and hand the landed PRs back (`release`); the
 * Mac takes them, and its first poll starts fresh errands. **Take back
 * anyway** does that from the last read when the VM cannot be reached, and
 * tells the VM to stand down when it next connects.
 */
import {
    actionRoute,
    broughtBack,
    dismissedSummary,
    ghAuthCheck,
    handedOff,
    mergingHostView,
    onVmConnected,
    pickVm,
    quitPrompt,
    stoodDown,
    tookBackAnyway,
    type MergingHostRecord,
    type VmChoice,
} from '../../domain/merge-manager/merging-host';
import {
    LANE_SAVINGS,
    type LandedPullRequest,
    type LaneSaving,
    type MergeManagerState,
} from '../../domain/merge-manager/model';
import {weekStart, type MergeManagerPageFacts} from '../../domain/merge-manager/page';
import {landedTransitions, type LandedTransitions} from '../../domain/merge-manager/transitions';
import type {FixErrand} from '../../domain/merge-manager/errands';
import type {MergeCallMethod} from '../../domain/agent/protocol';
import type {Clock, TimerHandle, Timers} from '../ports/clock';
import type {GitHubWrite} from '../ports/github-cli';
import type {Logger} from '../ports/logger';
import type {RendererGateway} from '../ports/renderer-gateway';
import type {FixErrandService, TryAgainResult} from './fix-errand-service';
import type {LandResult, MergeManagerService} from './merge-manager-service';
import {errandView} from './merge-manager-page-service';

/** How often the VM's lanes are read while it merges, as the Mac's own are. */
export const REMOTE_LANES_MS = 60_000;

/** How long a VM gets to finish the step under way and hand merging back. */
export const BRING_BACK_TIMEOUT_MS = 5 * 60_000;

/** How long the hand-off waits for the VM's link and its `gh auth status`. */
export const REACH_TIMEOUT_MS = 20_000;

/** The link to a VM's agent, as far as merging needs it. */
export interface MergingLink {
    readonly connected: boolean;
    /** The VM user's home, where `gh auth status` runs. */
    readonly home: string | null;
    whenConnected(): Promise<void>;
    /** Dial again now, also after the link gave up; a no-op while connected or dialling. */
    retryNow(): void;
    runTool(
        tool: 'gh',
        cwd: string,
        args: readonly string[],
        options: {timeoutMs: number},
    ): Promise<{code: number; stdout: Buffer; stderr: string}>;
    mergeCall(method: MergeCallMethod, args?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}

export interface MergingHostServiceDeps {
    local: Pick<
        MergeManagerService,
        'state' | 'land' | 'unland' | 'start' | 'pause' | 'focused' | 'adopt' | 'all' | 'onTransitions'
    >;
    errands: Pick<FixErrandService, 'tryAgain' | 'handOver'>;
    page: {facts(): Promise<MergeManagerPageFacts>};
    /** The registered VMs. */
    vms(): VmChoice[];
    /** The link to a VM's agent, by its key; null when it is not registered. */
    link(key: string): MergingLink | null;
    /** Hear each VM link come up, by its key. */
    onConnected(listener: (key: string) => void): void;
    record: {read(): MergingHostRecord; write(record: MergingHostRecord): void};
    /** The VM's lanes were read: the errands it started by itself can become rows here. */
    remoteRead?(key: string): void;
    /** Stop a session here (a fix errand the hand-off took over). */
    stopSession(sessionId: string): void;
    renderer: Pick<RendererGateway, 'mergeManagerChanged'>;
    clock: Clock;
    timers: Timers;
    log: Logger;
}

/** What the VM answers `state` with (`MergeHostState` on the agent). */
interface RemoteRead {
    state: MergeManagerState;
    landed: LandedPullRequest[];
    errands: FixErrand[];
    savedByRepository: Record<string, Record<LaneSaving, number>>;
}

export type HandOffResult = {ok: true; warning: string | null} | {ok: false; reason: string; fix?: string};

export type MergingBringBackResult = {ok: true} | {ok: false; reason: string; unreachable: boolean};

export class MergingHostService {
    private record: MergingHostRecord;
    /** The VM's last read while it merges. */
    private remote: RemoteRead | null = null;
    private reachable = true;
    private remoteTimer: TimerHandle | null = null;
    private refreshing: Promise<void> | null = null;
    /** A hand-off or bring-back under way: one at a time. */
    private moving = false;
    private readonly followers: Array<(transitions: LandedTransitions) => void> = [];

    constructor(private readonly deps: MergingHostServiceDeps) {
        this.record = deps.record.read();
        deps.local.onTransitions((transitions) => this.tell(transitions));
        deps.onConnected((key) => void this.connected(key));
    }

    /** At app start: run the lanes here, or follow the VM that merges. */
    public start(): void {
        if (this.record.kind === 'mac') {
            this.deps.local.start();
        } else {
            void this.deps.local.pause();
            this.followRemote();
        }
    }

    public stop(): void {
        this.deps.timers.clearInterval(this.remoteTimer);
        this.remoteTimer = null;
    }

    /** The window got focus. */
    public focused(): void {
        if (this.record.kind === 'mac') {
            this.deps.local.focused();
            return;
        }
        this.wake(this.deps.link(this.record.vm.key));
        void this.refresh();
    }

    /** Hear merges and PRs going to Needs you, wherever merging runs. */
    public onTransitions(fn: (transitions: LandedTransitions) => void): void {
        this.followers.push(fn);
    }

    /** The local Merge manager pushed its state: shown while this Mac merges. */
    public localChanged(state: MergeManagerState): void {
        if (this.record.kind === 'mac') this.deps.renderer.mergeManagerChanged(this.decorate(state));
    }

    /** The lanes as the Merging host runs them, and where that is. */
    public state(): MergeManagerState {
        if (this.record.kind === 'mac') return this.decorate(this.deps.local.state());
        return this.decorate(this.remote?.state ?? {lanes: [], needsYou: 0});
    }

    // ── The buttons, here or forwarded ──

    public land(repository: string, number: number): Promise<LandResult> {
        return this.route('land', {repository, number}, () => this.deps.local.land(repository, number));
    }

    public unland(repository: string, number: number): Promise<GitHubWrite> {
        return this.route('unland', {repository, number}, () => this.deps.local.unland(repository, number));
    }

    public tryAgain(repository: string, number: number, note: string | null): Promise<TryAgainResult> {
        return this.route('try-again', {repository, number, note}, () =>
            this.deps.errands.tryAgain(repository, number, note),
        );
    }

    /** The page's facts: the VM's savings and errands while it merges, this Mac's checkouts either way. */
    public async pageFacts(): Promise<MergeManagerPageFacts> {
        const local = await this.deps.page.facts();
        if (this.record.kind === 'mac' || !this.remote) return local;
        const byRepository = this.remote.savedByRepository;
        const total = Object.fromEntries(LANE_SAVINGS.map((kind) => [kind, 0])) as Record<LaneSaving, number>;
        for (const counts of Object.values(byRepository)) for (const kind of LANE_SAVINGS) total[kind] += counts[kind];
        return {
            savedThisWeek: total,
            savedByRepository: byRepository,
            errands: this.remote.errands.map(errandView),
            checkouts: local.checkouts,
        };
    }

    /** What quitting asks: "Hand off merging to <VM>?", or null. */
    public quitPrompt(): {vm: VmChoice; vms: readonly VmChoice[]} | null {
        return quitPrompt(this.record, this.deps.local.state(), this.deps.vms());
    }

    // ── Moving ──

    /** Hand merging off to a VM (the one offered first when none is named). */
    public async handOff(vmKey?: string): Promise<HandOffResult> {
        if (this.record.kind !== 'mac') return {ok: false, reason: `Merging is already on ${this.record.vm.name}.`};
        const vms = this.deps.vms();
        const vm = vmKey ? vms.find((candidate) => candidate.key === vmKey) : pickVm(vms, this.record.lastVm);
        const link = vm ? this.deps.link(vm.key) : null;
        if (!vm || !link) return {ok: false, reason: 'That VM is not registered.'};
        if (this.moving) return {ok: false, reason: 'Merging is already moving.'};
        this.moving = true;
        try {
            const reached = await this.within(link.whenConnected(), REACH_TIMEOUT_MS).then(
                () => true,
                () => false,
            );
            if (!reached) return {ok: false, reason: `${vm.name} could not be reached.`};
            const gh = await this.within(
                link.runTool('gh', link.home ?? '/', ['auth', 'status'], {timeoutMs: REACH_TIMEOUT_MS}),
                REACH_TIMEOUT_MS + 5_000,
            ).catch((err: Error) => err);
            if (gh instanceof Error) return {ok: false, reason: `${vm.name} could not run gh: ${gh.message}`};
            const check = ghAuthCheck({code: gh.code, output: gh.stdout.toString('utf8') + '\n' + gh.stderr}, vm.name);
            if (!check.ok) return {ok: false, reason: check.reason, fix: check.fix};

            // The step under way finishes; then nothing runs here.
            await this.deps.local.pause();
            for (const sessionId of this.deps.errands.handOver()) this.deps.stopSession(sessionId);
            const landed = this.deps.local.all();
            try {
                await link.mergeCall('take', {landed, noWorkflowScope: check.warning !== null});
            } catch (err) {
                this.deps.local.start();
                return {ok: false, reason: `${vm.name} did not take merging: ${(err as Error).message}`};
            }
            this.remote = {state: this.deps.local.state(), landed, errands: [], savedByRepository: {}};
            this.reachable = true;
            this.save(handedOff(vm, check.warning, this.deps.clock.now()));
            this.deps.log.info(`[merging-host] handed merging off to ${vm.name}`);
            this.followRemote();
            this.publish();
            return {ok: true, warning: check.warning};
        } finally {
            this.moving = false;
        }
    }

    /** Bring merging back: the VM finishes its step, stops its errands and hands its landed PRs back. */
    public async bringBack(): Promise<MergingBringBackResult> {
        if (this.record.kind !== 'vm') return {ok: true};
        const vm = this.record.vm;
        const link = this.deps.link(vm.key);
        if (!link) return {ok: false, reason: `${vm.name} is not registered any more.`, unreachable: true};
        if (this.moving) return {ok: false, reason: 'Merging is already moving.', unreachable: false};
        this.moving = true;
        this.wake(link);
        try {
            const answer = await this.within(
                link.mergeCall('release', {}, BRING_BACK_TIMEOUT_MS),
                BRING_BACK_TIMEOUT_MS,
            )
                .then((result) => ({ok: true as const, result}))
                .catch((err: Error) => ({ok: false as const, error: err.message}));
            if (!answer.ok) {
                this.reachable = false;
                this.publish();
                return {ok: false, reason: `${vm.name} did not answer: ${answer.error}`, unreachable: true};
            }
            const landed = (answer.result as {landed?: LandedPullRequest[]} | null)?.landed;
            this.takeOver(Array.isArray(landed) ? landed : (this.remote?.landed ?? this.deps.local.all()));
            this.save(broughtBack(this.record));
            this.deps.log.info(`[merging-host] brought merging back from ${vm.name}`);
            this.publish();
            return {ok: true};
        } finally {
            this.moving = false;
        }
    }

    /** Take merging back while the VM cannot be reached; it stands down when it next connects. */
    public takeBackAnyway(): {ok: true} {
        if (this.record.kind !== 'vm') return {ok: true};
        const vm = this.record.vm;
        this.takeOver(this.remote?.landed ?? this.deps.local.all());
        this.save(tookBackAnyway(this.record));
        this.deps.log.warn(`[merging-host] took merging back from ${vm.name} without it`);
        this.publish();
        // It may be back already.
        if (this.deps.link(vm.key)?.connected) void this.connected(vm.key);
        return {ok: true};
    }

    public dismissSummary(): void {
        this.save(dismissedSummary(this.record));
        this.publish();
    }

    // ── Inside ──

    private takeOver(landed: readonly LandedPullRequest[]): void {
        this.stop();
        this.remote = null;
        this.reachable = true;
        this.deps.local.adopt(landed);
        this.deps.local.start();
    }

    private async route<T>(method: MergeCallMethod, args: Record<string, unknown>, here: () => Promise<T>): Promise<T> {
        const where = actionRoute(this.record);
        if (where.to === 'mac') return here();
        const link = this.deps.link(where.vm.key);
        if (!link) throw new Error(`${where.vm.name} is not registered`);
        this.wake(link);
        const result = (await link.mergeCall(method, args)) as T;
        void this.refresh();
        return result;
    }

    /**
     * A link that gave up (out of attempts, or a sign-in that failed) is not
     * dialled again by itself, and the minute's read does not dial it either.
     * Looking at the app or pressing a button does.
     */
    private wake(link: MergingLink | null): void {
        if (link && !link.connected) link.retryNow();
    }

    private followRemote(): void {
        this.stop();
        this.remoteTimer = this.deps.timers.setInterval(() => void this.refresh(), REMOTE_LANES_MS);
        void this.refresh();
    }

    /** Read the VM's lanes once; a read under way is joined. */
    private refresh(): Promise<void> {
        if (this.record.kind !== 'vm') return Promise.resolve();
        this.refreshing ??= this.readRemote().finally(() => (this.refreshing = null));
        return this.refreshing;
    }

    private async readRemote(): Promise<void> {
        if (this.record.kind !== 'vm') return;
        const vm = this.record.vm;
        const link = this.deps.link(vm.key);
        const read = link
            ? await this.within(link.mergeCall('state', {since: weekStart(this.deps.clock.now())}), REACH_TIMEOUT_MS)
                  .then((result) => result as RemoteRead)
                  .catch((err: Error) => {
                      this.deps.log.warn(`[merging-host] ${vm.name}'s lanes not read: ${err.message}`);
                      return null;
                  })
            : null;
        if (this.record.kind !== 'vm' || this.record.vm.key !== vm.key) return;
        if (!read || !Array.isArray(read.landed) || !read.state) {
            this.reachable = false;
        } else {
            const before = new Map((this.remote?.landed ?? []).map((pr) => [pr.key, pr]));
            this.remote = read;
            this.reachable = true;
            this.deps.remoteRead?.(vm.key);
            if (before.size > 0) this.tell(landedTransitions(before, read.landed));
        }
        this.publish();
    }

    /** A VM's link came up: one merging was taken back from stands down; the one merging is read. */
    private async connected(key: string): Promise<void> {
        if (onVmConnected(this.record, key) === 'stand-down') {
            const link = this.deps.link(key);
            try {
                await link?.mergeCall('stand-down');
                this.save(stoodDown(this.record));
                this.deps.log.info(`[merging-host] ${key} stood down`);
            } catch (err) {
                this.deps.log.warn(`[merging-host] ${key} did not stand down yet: ${(err as Error).message}`);
            }
            return;
        }
        if (this.record.kind === 'vm' && this.record.vm.key === key) void this.refresh();
    }

    private tell(transitions: LandedTransitions): void {
        if (transitions.merged.length === 0 && transitions.needsYou.length === 0) return;
        for (const fn of this.followers) {
            try {
                fn(transitions);
            } catch (err) {
                this.deps.log.error('[merging-host] a transition follower failed:', (err as Error).message);
            }
        }
    }

    private decorate(state: MergeManagerState): MergeManagerState {
        return {...state, merging: mergingHostView(this.record, state, this.deps.vms(), this.reachable)};
    }

    private publish(): void {
        this.deps.renderer.mergeManagerChanged(this.state());
    }

    private save(record: MergingHostRecord): void {
        this.record = record;
        this.deps.record.write(record);
    }

    private within<T>(promise: Promise<T>, ms: number): Promise<T> {
        return new Promise((resolve, reject) => {
            const timer = this.deps.timers.setTimeout(
                () => reject(new Error(`no answer in ${Math.round(ms / 1000)}s`)),
                ms,
            );
            promise.then(
                (value) => {
                    this.deps.timers.clearTimeout(timer);
                    resolve(value);
                },
                (err: unknown) => {
                    this.deps.timers.clearTimeout(timer);
                    reject(err instanceof Error ? err : new Error(String(err)));
                },
            );
        });
    }
}
