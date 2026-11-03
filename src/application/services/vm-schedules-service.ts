/**
 * The Mac's side of where a project's schedules run (#276 stage 5, Q18),
 * behind the `VmSchedules` façade.
 *
 * A copy on a VM has the same `schedule-*.md` as the local project it was made
 * from, so one place must run them: this Mac, or one copy. The choice is kept
 * per local project in settings (`SettingsService.vmSchedules`), and a VM
 * learns of it through its host settings' `scheduleDirs`, which its own
 * schedule loop reads. Keeping that list on the VM is what lets schedules run
 * while the Mac is off; keeping the choice on the Mac is what lets the Mac's
 * loop pause the project (`macRunsSchedulesOf`).
 *
 * The rule is that no schedule runs in two places for longer than it takes a
 * VM to reconnect:
 * - a move to a copy is stored only once its VM confirms the folder is in its
 *   list, so the Mac never pauses for a VM that was not told;
 * - a move back to the Mac is stored at once, even when the VM cannot be
 *   reached, so the Mac never stays paused for a VM that is away; the VM's
 *   removal waits for its next connect;
 * - a move to a copy that could not be told waits for that VM's next connect
 *   too, and is stored then;
 * - on every connect the VM's list is brought in line with the stored choices.
 *
 * Runs made on a VM were started by nobody on the Mac, so the Mac has no
 * record of them. On connect, and every few minutes while connected, the VM is
 * asked which sessions ran in the copies whose schedules it runs, and each new
 * one gets a remote session record on its copy: that makes it a VM session row,
 * titled from `VmTranscripts` like any other.
 */
import {SCHEDULE_COMMANDS_SUBPATH, isScheduleFileName} from '../../domain/schedule/schedule';
import {parseRemoteProjectPath} from '../../domain/project/remote-target';
import type {RemoteConfig} from '../../domain/project/remote-target';
import type {Clock, TimerHandle, Timers} from '../ports/clock';
import type {FileSystem} from '../ports/file-system';
import type {Logger} from '../ports/logger';
import type {RendererGateway} from '../ports/renderer-gateway';
import {agentHostKey} from './agent-client/agent-client';
import type {AgentClient} from './agent-client/agent-client';
import type {AgentConnection} from './agent-client/agent-connection';
import {HOST_REACH_TIMEOUT_MS} from './agent-hosts-service';
import type {HandoffChoices} from './project-handoff';
import {withTimeout} from './project-handoff-service';
import type {SettingsService, VmScheduleState} from './settings-service';
import {WORKTREES_DIR} from './support/branch-worktrees';
import type {ScheduleLocation, VmSchedules} from './vm-schedules';

/** How often a connected VM is asked for the runs its schedules made. */
export const VM_RUNS_POLL_MS = 5 * 60 * 1000;

export interface VmSchedulesServiceDeps {
    agents: Pick<AgentClient, 'connection' | 'onConnected'>;
    settings: Pick<
        SettingsService,
        'remoteProjects' | 'findRemoteProject' | 'touchRemoteSession' | 'vmSchedules' | 'updateVmSchedules'
    >;
    /** To count a local project's schedule files. */
    fs: Pick<FileSystem, 'exists' | 'readDir' | 'join'>;
    /** Told when a run from a VM became a row, or a waiting move landed, so the lists and pages refresh. */
    renderer: Pick<RendererGateway, 'projectsChanged'>;
    clock: Clock;
    timers: Timers;
    log: Logger;
    /** How long a change waits for the VM's link to come up; HOST_REACH_TIMEOUT_MS by default. */
    reachTimeoutMs?: number;
    /** How often connected VMs are asked for their runs; VM_RUNS_POLL_MS by default. */
    pollMs?: number;
}

/** A copy, placed: its host and its folder there. */
interface PlacedCopy {
    copyPath: string;
    host: RemoteConfig;
    hostKey: string;
    /** As the project path names it, `~` kept: the form `scheduleDirs` holds. */
    dir: string;
}

type Edited = {ok: true; dirs: string[]} | {ok: false; error: string};

export class VmSchedulesService implements VmSchedules {
    /** Every change to a host's `scheduleDirs` goes through here, one at a time, so two never read the same list. */
    private chain: Promise<unknown> = Promise.resolve();
    /** Hosts whose runs are being listed right now, so a tick and a connect do not ask twice. */
    private readonly polling = new Set<string>();
    private pollTimer: TimerHandle | null = null;
    private started = false;

    constructor(private readonly deps: VmSchedulesServiceDeps) {}

    /**
     * Reconcile and read runs on every connect, and read runs every few
     * minutes. Once, from the composition root, after the agent client exists.
     */
    public start(): void {
        if (this.started) return;
        this.started = true;
        this.deps.agents.onConnected((connection) => void this.connected(connection));
        this.pollTimer = this.deps.timers.setInterval(() => void this.pollAll(), this.deps.pollMs ?? VM_RUNS_POLL_MS);
    }

    public stop(): void {
        this.deps.timers.clearInterval(this.pollTimer);
        this.pollTimer = null;
    }

    // ── The façade ──

    public async where(projectPath: string): Promise<ScheduleLocation | null> {
        const localPath = this.localOf(projectPath);
        if (!localPath) return null;
        const count = this.countSchedules(localPath);
        if (count === 0 && !this.hasCopies(localPath)) return null;
        return this.location(localPath, count);
    }

    public runOn(localPath: string, copyPath: string | null): Promise<ScheduleLocation | {error: string}> {
        if (parseRemoteProjectPath(localPath)) {
            return Promise.resolve({error: 'Schedules are switched from the local project, not from a copy.'});
        }
        if (copyPath && this.deps.settings.findRemoteProject(copyPath)?.copyOf !== localPath) {
            return Promise.resolve({error: `${copyPath} is not a copy of ${localPath}.`});
        }
        return this.serial(() => {
            // The user's latest word wins over a move still waiting for its VM.
            this.deps.settings.updateVmSchedules((state) => void delete state.pendingMoves[localPath]);
            return this.move(localPath, copyPath);
        });
    }

    // ── For the composition root ──

    /**
     * Whether the Mac's own schedule loop runs `projectPath`'s schedules: false
     * for a local project (or one of its worktrees) whose schedules run on a
     * VM. Passed to `ScheduleService` as its `runsHere`.
     */
    public macRunsSchedulesOf(projectPath: string): boolean {
        for (const localPath of Object.keys(this.choices())) {
            const root = localPath.replace(/\/+$/, '');
            if (projectPath === localPath || projectPath === root || projectPath.startsWith(root + WORKTREES_DIR)) {
                return false;
            }
        }
        return true;
    }

    /**
     * `ProjectHandoffService`'s `afterHandoff`: a hand-off whose dialog said to
     * run the schedules on the VM moves them to the new copy. A VM that could
     * not be told gets the move on its next connect, so the hand-off itself
     * never fails over it.
     */
    public async afterHandoff(localPath: string, copyPath: string, choices: HandoffChoices): Promise<void> {
        if (!choices.schedulesOnVm) return;
        const moved = await this.runOn(localPath, copyPath);
        if ('error' in moved) this.deps.log.warn(`[vm-schedules] after the hand-off of ${localPath}: ${moved.error}`);
    }

    // ── Moving ──

    /** The move itself, inside `serial`. */
    private async move(localPath: string, target: string | null): Promise<ScheduleLocation | {error: string}> {
        const {settings, clock, log} = this.deps;
        const old = settings.vmSchedules().choices[localPath]?.copyPath ?? null;
        const from = old ? placeCopy(old) : null;

        if (target) {
            const to = placeCopy(target);
            if (!to) return {error: `${target} is not a copy on a VM.`};
            // The old copy on the same VM goes in the same edit, so the list never has both.
            const sameHost = from && from.hostKey === to.hostKey && from.dir !== to.dir ? from.dir : null;
            const edited = await this.edit(to, (dirs) => withDir(without(dirs, sameHost ? [sameHost] : []), to.dir));
            if (!edited.ok || !edited.dirs.includes(to.dir)) {
                const why = edited.ok ? `the agent on ${hostLabel(to.host)} did not take the folder` : edited.error;
                settings.updateVmSchedules((state) => void (state.pendingMoves[localPath] = target));
                log.warn(`[vm-schedules] ${localPath} → ${target} waits for its VM: ${why}`);
                const now = old ? 'in the copy they run in now' : 'on this Mac';
                return {
                    error: `Could not move the schedules to ${hostLabel(to.host)}: ${why}. Switchboard moves them when it next connects to it; until then they run ${now}.`,
                };
            }
            settings.updateVmSchedules((state) => {
                state.choices[localPath] = {copyPath: target, at: new Date(clock.now()).toISOString()};
            });
            log.info(`[vm-schedules] ${localPath} runs its schedules in ${target}`);
            if (from && from.hostKey !== to.hostKey) await this.dropFrom(from);
        } else {
            // Back to the Mac at once: a VM that is away must not keep the Mac paused.
            settings.updateVmSchedules((state) => void delete state.choices[localPath]);
            log.info(`[vm-schedules] ${localPath} runs its schedules on this Mac`);
            if (from) await this.dropFrom(from);
        }
        return this.location(localPath, this.countSchedules(localPath));
    }

    /** Take a copy's folder off its VM's list, or leave that for the VM's next connect. */
    private async dropFrom(copy: PlacedCopy): Promise<void> {
        const edited = await this.edit(copy, (dirs) => without(dirs, [copy.dir]));
        if (edited.ok) return;
        this.deps.settings.updateVmSchedules((state) => {
            const pending = state.pendingRemovals[copy.hostKey] ?? [];
            if (!pending.includes(copy.dir)) pending.push(copy.dir);
            state.pendingRemovals[copy.hostKey] = pending;
        });
        this.deps.log.warn(
            `[vm-schedules] ${copy.dir} leaves ${copy.hostKey}'s schedules on its next connect: ${edited.error}`,
        );
    }

    /**
     * Change a host's `scheduleDirs`: read it fresh, take off what is waiting
     * to come off, apply `change`, and write it back when it differs. The
     * waiting removals are done once the VM answers.
     */
    private async edit(copy: PlacedCopy, change: (dirs: string[]) => string[]): Promise<Edited> {
        let connection: AgentConnection;
        try {
            connection = await this.reach(copy.host);
        } catch (err) {
            return {ok: false, error: `could not reach ${hostLabel(copy.host)}: ${(err as Error).message}`};
        }
        try {
            const current = (await connection.getHostSettings()).scheduleDirs ?? [];
            return {ok: true, dirs: await this.write(connection, copy.hostKey, current, change)};
        } catch (err) {
            return {ok: false, error: `${hostLabel(copy.host)} did not take it: ${(err as Error).message}`};
        }
    }

    /** `current`, less the host's waiting removals, through `change`; written when it differs. */
    private async write(
        connection: AgentConnection,
        hostKey: string,
        current: string[],
        change: (dirs: string[]) => string[],
    ): Promise<string[]> {
        const pending = this.deps.settings.vmSchedules().pendingRemovals[hostKey] ?? [];
        const next = change(without(current, pending));
        let dirs = current;
        if (!sameSet(next, current)) {
            const reply = await connection.setHostSettings({scheduleDirs: next});
            // An agent from before stage 5 drops the field it does not know.
            if (!Array.isArray(reply.scheduleDirs) && next.length > 0) {
                throw new Error('its agent is too old to run schedules; update it from the project page');
            }
            dirs = reply.scheduleDirs ?? [];
        }
        if (pending.length > 0) {
            this.deps.settings.updateVmSchedules((state) => void delete state.pendingRemovals[hostKey]);
        }
        return dirs;
    }

    // ── On connect ──

    private async connected(connection: AgentConnection): Promise<void> {
        await this.serial(() => this.reconcile(connection)).catch((err: unknown) => {
            this.deps.log.warn(`[vm-schedules] could not reconcile ${connection.target}: ${(err as Error).message}`);
        });
        await this.poll(connection);
    }

    /**
     * Bring the host's list in line with the stored choices: the chosen copies
     * on it in, the waiting removals and this Mac's other copies on it out.
     * Folders the Mac knows nothing of stay, being somebody else's to manage.
     * Then the moves that were waiting for this host.
     */
    private async reconcile(connection: AgentConnection): Promise<void> {
        const {settings, log, renderer} = this.deps;
        const hostKey = agentHostKey(connection.host);
        const chosen = new Set(this.chosenOn(hostKey).map((copy) => copy.dir));
        const known = new Set(
            settings
                .remoteProjects()
                .filter((remote) => remote.copyOf && remote.dir && agentHostKey(remote) === hostKey)
                .map((remote) => remote.dir as string),
        );
        const current = connection.settings?.scheduleDirs ?? [];
        await this.write(connection, hostKey, current, (dirs) => [
            ...dirs.filter((dir) => !known.has(dir) || chosen.has(dir)),
            ...[...chosen].filter((dir) => !dirs.includes(dir)),
        ]);

        const waiting = Object.entries(settings.vmSchedules().pendingMoves).filter(
            ([, copyPath]) => placeCopy(copyPath)?.hostKey === hostKey,
        );
        for (const [localPath, copyPath] of waiting) {
            settings.updateVmSchedules((state) => void delete state.pendingMoves[localPath]);
            // The copy may have been removed while the move waited.
            if (settings.findRemoteProject(copyPath)?.copyOf !== localPath) continue;
            const moved = await this.move(localPath, copyPath);
            if ('error' in moved) log.warn(`[vm-schedules] the waiting move of ${localPath}: ${moved.error}`);
            else renderer.projectsChanged();
        }
    }

    // ── Runs made on the VM ──

    private async pollAll(): Promise<void> {
        const hosts = new Map<string, RemoteConfig>();
        for (const copy of this.placedChoices()) hosts.set(copy.hostKey, copy.host);
        for (const host of hosts.values()) {
            const connection = this.deps.agents.connection(host);
            // Never dials: a VM that is away is asked once it is back, on its connect.
            if (connection.connected) await this.poll(connection);
        }
    }

    /**
     * Ask the host for the sessions that ran in its scheduled copies since the
     * last ask, and record each new one on its copy. A session the Mac already
     * has a record of (one it opened there, or handed off) is left alone.
     */
    private async poll(connection: AgentConnection): Promise<void> {
        const {settings, log, renderer} = this.deps;
        const hostKey = agentHostKey(connection.host);
        const copies = this.chosenOn(hostKey);
        if (copies.length === 0 || this.polling.has(hostKey)) return;
        this.polling.add(hostKey);
        try {
            const state = settings.vmSchedules();
            const since = state.runsSince[hostKey] ?? earliestChoice(state, copies);
            const sessions = await connection.listTranscripts(
                copies.map((copy) => copy.dir),
                since,
            );
            const known = new Set(
                settings.remoteProjects().flatMap((remote) => (remote.sessions ?? []).map((s) => s.sessionId)),
            );
            let newest = since ?? 0;
            let recorded = 0;
            for (const session of sessions) {
                newest = Math.max(newest, session.mtimeMs);
                if (known.has(session.sessionId)) continue;
                const copy = copyHolding(copies, session.dir, connection.home);
                if (!copy) continue;
                const at = new Date(session.mtimeMs).toISOString();
                if (settings.touchRemoteSession(copy.copyPath, session.sessionId, 'claude', at)) {
                    known.add(session.sessionId);
                    recorded++;
                }
            }
            if (newest > 0) settings.updateVmSchedules((s) => void (s.runsSince[hostKey] = newest));
            if (recorded > 0) {
                log.info(`[vm-schedules] ${recorded} run(s) on ${connection.target} recorded`);
                renderer.projectsChanged();
            }
        } catch (err) {
            log.warn(`[vm-schedules] could not list the runs on ${connection.target}: ${(err as Error).message}`);
        } finally {
            this.polling.delete(hostKey);
        }
    }

    // ── Helpers ──

    /** One at a time, whatever the one before did. */
    private serial<T>(work: () => Promise<T>): Promise<T> {
        const run = this.chain.then(work, work);
        this.chain = run.catch(() => undefined);
        return run;
    }

    /** The host's link, up; rejects when it cannot be had within the reach timeout. */
    private async reach(host: RemoteConfig): Promise<AgentConnection> {
        const connection = this.deps.agents.connection(host);
        if (connection.state === 'failed') connection.retryNow();
        await withTimeout(
            connection.whenConnected(),
            this.deps.reachTimeoutMs ?? HOST_REACH_TIMEOUT_MS,
            this.deps.timers,
        );
        return connection;
    }

    /** The local project behind a path: itself, or the one a copy was made from; null for any other remote. */
    private localOf(projectPath: string): string | null {
        const remote = this.deps.settings.findRemoteProject(projectPath);
        if (remote) return remote.copyOf ?? null;
        return parseRemoteProjectPath(projectPath) ? null : projectPath;
    }

    private hasCopies(localPath: string): boolean {
        return this.deps.settings.remoteProjects().some((remote) => remote.copyOf === localPath);
    }

    /**
     * The stored choices whose copy still exists. A copy removed since leaves
     * its project running on the Mac rather than paused for nothing.
     */
    private choices(): VmScheduleState['choices'] {
        const {settings} = this.deps;
        const stored = settings.vmSchedules().choices;
        return Object.fromEntries(
            Object.entries(stored).filter(
                ([localPath, choice]) => settings.findRemoteProject(choice.copyPath)?.copyOf === localPath,
            ),
        );
    }

    private placedChoices(): PlacedCopy[] {
        return Object.values(this.choices())
            .map((choice) => placeCopy(choice.copyPath))
            .filter((copy): copy is PlacedCopy => copy !== null);
    }

    private chosenOn(hostKey: string): PlacedCopy[] {
        return this.placedChoices().filter((copy) => copy.hostKey === hostKey);
    }

    private location(localPath: string, count: number): ScheduleLocation {
        const choice = this.choices()[localPath];
        return {localPath, runsOn: choice ? {kind: 'vm', copyPath: choice.copyPath} : {kind: 'mac'}, count};
    }

    /** The `schedule-*.md` in the local project's `.claude/commands`; 0 when there is no such folder. */
    private countSchedules(localPath: string): number {
        const {fs} = this.deps;
        const dir = fs.join(localPath, ...SCHEDULE_COMMANDS_SUBPATH);
        if (!fs.exists(dir)) return 0;
        try {
            return fs.readDir(dir).filter((entry) => entry.isFile && isScheduleFileName(entry.name)).length;
        } catch {
            return 0;
        }
    }
}

/** A copy's host and folder, from its project path; null for a path with no folder on a host. */
function placeCopy(copyPath: string): PlacedCopy | null {
    const parsed = parseRemoteProjectPath(copyPath);
    if (!parsed?.dir) return null;
    const host = {user: parsed.user, host: parsed.host, port: parsed.port};
    return {copyPath, host, hostKey: agentHostKey(host), dir: parsed.dir};
}

/**
 * The copy a session ran in: the one whose folder is the session's, or holds
 * it (a worktree below the copy). The agent may answer with `~` expanded, so
 * both forms match.
 */
function copyHolding(copies: PlacedCopy[], dir: string, home: string | null): PlacedCopy | null {
    const clean = (path: string) => path.replace(/\/+$/, '');
    const expand = (path: string) =>
        home && (path === '~' || path.startsWith('~/')) ? clean(home) + path.slice(1) : path;
    const session = clean(dir);
    let best: PlacedCopy | null = null;
    let bestLength = -1;
    for (const copy of copies) {
        for (const form of new Set([clean(copy.dir), clean(expand(copy.dir))])) {
            if ((session === form || session.startsWith(form + '/')) && form.length > bestLength) {
                best = copy;
                bestLength = form.length;
            }
        }
    }
    return best;
}

/** Where to start reading a host's runs before any were read: when its first copy was chosen. */
function earliestChoice(state: VmScheduleState, copies: PlacedCopy[]): number | undefined {
    const paths = new Set(copies.map((copy) => copy.copyPath));
    const times = Object.values(state.choices)
        .filter((choice) => paths.has(choice.copyPath))
        .map((choice) => Date.parse(choice.at))
        .filter((ms) => Number.isFinite(ms));
    return times.length > 0 ? Math.min(...times) : undefined;
}

function without(dirs: readonly string[], removed: readonly string[]): string[] {
    return dirs.filter((dir) => !removed.includes(dir));
}

function withDir(dirs: readonly string[], dir: string): string[] {
    return dirs.includes(dir) ? [...dirs] : [...dirs, dir];
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
    const set = new Set(a);
    return set.size === new Set(b).size && b.every((dir) => set.has(dir));
}

/** `user@host`, with the port when it is not 22, as the hand-off picker names a VM. */
function hostLabel(host: Pick<RemoteConfig, 'user' | 'host' | 'port'>): string {
    const port = Number(host.port) || 22;
    return `${host.user}@${host.host}${port === 22 ? '' : `:${port}`}`;
}
