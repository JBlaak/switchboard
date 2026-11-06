/**
 * Reading and writing settings, with the layering applied.
 *
 * The store underneath is a dumb key/value map. Everything that makes settings
 * make sense — that there is one global blob and one blob per project, that a
 * null means "inherit", which keys have defaults, and that hidden projects and
 * remote projects live inside the global blob rather than beside it — is here.
 */
import {
    GLOBAL_SETTINGS_KEY,
    mergeEffectiveSettings,
    projectSettingsKey,
    resolveShellProfileId,
    resolveQuickAskEnabled,
    resolveRemoveWorktreeOnArchive,
    resolveRestoreSessions,
    resolveWeatherEnabled,
    resolveWeatherLocation,
} from '../../domain/settings/settings';
import {normalizeRemoteDir, parseRemoteProjectPath, remoteProjectPath} from '../../domain/project/remote-target';
import type {
    EffectiveSettings,
    GlobalSettings,
    RemoteProjectSetting,
    VmHostSetting,
} from '../../domain/settings/settings';
import {findVmHostIn, migrateVmHosts, sameHost, withDerivedAgent} from '../../domain/settings/vm-hosts';
import type {HostAddress} from '../../domain/settings/vm-hosts';
import type {RemoteSessionRecord} from '../../domain/session/session';
import type {WeatherLocation} from '../../domain/weather/weather';
import type {SettingsStore} from '../ports/settings-store';

export class SettingsService {
    constructor(private readonly store: SettingsStore) {}

    public get<T = unknown>(key: string): T | null {
        return this.store.get<T>(key);
    }

    public set(key: string, value: unknown): void {
        this.store.set(key, value);
    }

    public global(): GlobalSettings {
        return this.store.get<GlobalSettings>(GLOBAL_SETTINGS_KEY) || {};
    }

    public saveGlobal(settings: GlobalSettings): void {
        this.store.set(GLOBAL_SETTINGS_KEY, settings);
    }

    /**
     * Read the global blob, let the caller change it, and write it back.
     *
     * Read-modify-write is how every global setting is changed, and doing it by
     * hand at each call site is how a caller ends up dropping the keys it did not
     * know about.
     */
    public updateGlobal<T>(mutate: (settings: GlobalSettings) => T): T {
        const settings = this.global();
        const result = mutate(settings);
        this.saveGlobal(settings);
        return result;
    }

    public project(projectPath: string | null | undefined): Record<string, unknown> {
        if (!projectPath) return {};
        return this.store.get<Record<string, unknown>>(projectSettingsKey(projectPath)) || {};
    }

    public forgetProject(projectPath: string): void {
        this.store.delete(projectSettingsKey(projectPath));
    }

    public effective(projectPath: string | null | undefined): EffectiveSettings {
        return mergeEffectiveSettings(this.global(), this.project(projectPath));
    }

    /** The shell profile id a project should launch in. */
    public shellProfileId(projectPath?: string | null): string {
        return resolveShellProfileId(this.global(), projectPath ? this.project(projectPath) : null);
    }

    // ── Weather ──
    // Global only: it is the one empty screen's weather, not a project's.

    public weatherEnabled(): boolean {
        return resolveWeatherEnabled(this.global());
    }

    public weatherLocation(): WeatherLocation {
        return resolveWeatherLocation(this.global());
    }

    // ── Quick Ask ──

    public quickAskEnabled(): boolean {
        return resolveQuickAskEnabled(this.global());
    }

    // ── Archive ──

    public removeWorktreeOnArchive(): boolean {
        return resolveRemoveWorktreeOnArchive(this.global());
    }

    // ── Restore ──

    public restoreSessions(): boolean {
        return resolveRestoreSessions(this.global());
    }

    // ── Hidden projects ──
    // "Removing" a project does not delete anything: the transcripts stay on
    // disk, because Claude CLI owns them. It is a hide list.

    public hiddenProjects(): Set<string> {
        return new Set(this.global().hiddenProjects || []);
    }

    public hideProject(projectPath: string): void {
        this.updateGlobal((settings) => {
            const hidden = settings.hiddenProjects || [];
            if (!hidden.includes(projectPath)) hidden.push(projectPath);
            settings.hiddenProjects = hidden;
        });
    }

    public unhideProject(projectPath: string): void {
        this.updateGlobal((settings) => {
            if (!settings.hiddenProjects?.includes(projectPath)) return;
            settings.hiddenProjects = settings.hiddenProjects.filter((p) => p !== projectPath);
        });
    }

    // ── VMs ──
    // Registered on their own (#276, Settings → VMs), as phones are paired: the
    // one answer to which hosts run a Switchboard agent. Remote projects take
    // their `agent` from here (see `remoteProjects`).

    /**
     * The registered VMs. The first read on an install from before the
     * registry existed fills it in from the remotes that carried `agent`, and
     * stores it, so that happens once: after that an empty list means none.
     */
    public vmHosts(): VmHostSetting[] {
        const stored = this.global().vmHosts;
        if (stored) return stored;
        return this.updateGlobal((settings) => {
            settings.vmHosts ??= migrateVmHosts(settings.remoteProjects);
            return settings.vmHosts;
        });
    }

    /** The registration of `address`'s host, or null when it isn't a registered VM. */
    public findVmHost(address: HostAddress): VmHostSetting | null {
        return findVmHostIn(this.vmHosts(), address);
    }

    /**
     * Register a VM, with nothing installed yet. False when it is already
     * registered; the caller has validated the address.
     */
    public addVmHost(
        vm: {user: string; host: string; port: number; name?: string},
        addedAt = new Date().toISOString(),
    ): boolean {
        this.vmHosts();
        return this.updateGlobal((settings) => {
            const hosts = settings.vmHosts ?? [];
            if (findVmHostIn(hosts, vm)) return false;
            const name = vm.name?.trim();
            hosts.push({user: vm.user, host: vm.host, port: vm.port, ...(name ? {name} : {}), addedAt});
            settings.vmHosts = hosts;
            return true;
        });
    }

    /** Name a VM; an empty name goes back to the `user@host` label. False when it isn't registered. */
    public renameVmHost(address: HostAddress, name: string): boolean {
        this.vmHosts();
        return this.updateGlobal((settings) => {
            const vm = findVmHostIn(settings.vmHosts ?? [], address);
            if (!vm) return false;
            const trimmed = name.trim();
            if (trimmed) vm.name = trimmed;
            else delete vm.name;
            return true;
        });
    }

    /**
     * Take a VM out of the registry, and only that: its remote projects are
     * the caller's to forget (they then stop being VM projects, since their
     * `agent` came from here). False when it wasn't registered.
     */
    public removeVmHost(address: HostAddress): boolean {
        this.vmHosts();
        return this.updateGlobal((settings) => {
            const hosts = settings.vmHosts ?? [];
            const kept = hosts.filter((vm) => !sameHost(vm, address));
            settings.vmHosts = kept;
            return kept.length !== hosts.length;
        });
    }

    // ── Remote projects ──
    // Stored in settings rather than derived from the transcript directory: the
    // session history lives on the remote host, so the only local state is the
    // connection info and which tmux sessions we created.

    /**
     * Every remote project, with `agent` derived from its host's registration
     * (`withDerivedAgent`): set when the host is a registered VM with an agent,
     * absent otherwise, whatever the stored record says. Copies: change a
     * remote through the methods below, not by editing these.
     */
    public remoteProjects(): RemoteProjectSetting[] {
        const hosts = this.vmHosts();
        return (this.global().remoteProjects || []).map((remote) => withDerivedAgent(remote, hosts));
    }

    /** The remote project at `projectPath`, its `agent` derived as `remoteProjects` does. */
    public findRemoteProject(projectPath: string): RemoteProjectSetting | null {
        return this.remoteProjects().find((r) => remoteProjectPath(r) === projectPath) ?? null;
    }

    /** Adds a remote, or answers false when it is already there. */
    public addRemoteProject(remote: RemoteProjectSetting): boolean {
        const projectPath = remoteProjectPath(remote);
        return this.updateGlobal((settings) => {
            const list = settings.remoteProjects || [];
            if (list.some((r) => remoteProjectPath(r) === projectPath)) return false;
            list.push(remote);
            settings.remoteProjects = list;
            return true;
        });
    }

    /**
     * Add a remote, or update the one already at its project path (#276 stage
     * 2: handing a project off again lands on the same copy). An update takes
     * the connection info, `agent` and `copyOf` from `remote` and keeps the
     * sessions the stored one has, so a second hand-off forgets nothing.
     */
    public saveRemoteProject(remote: RemoteProjectSetting): void {
        const projectPath = remoteProjectPath(remote);
        this.updateGlobal((settings) => {
            const list = settings.remoteProjects || [];
            const index = list.findIndex((r) => remoteProjectPath(r) === projectPath);
            if (index < 0) list.push(remote);
            else list[index] = {...list[index], ...remote, sessions: remote.sessions ?? list[index].sessions};
            settings.remoteProjects = list;
        });
    }

    /**
     * The remote project at `projectPath`, recorded first when it is a folder
     * on a VM host that no record names yet (#276 stage 5).
     *
     * An issue or task session starts in a new worktree made on the VM
     * (`ssh://u@h//home/u/projects/site/.claude/worktrees/fix-42`). That
     * folder is nobody's project, but its sessions need a record: it is what
     * the launcher opens on the agent, what `touchRemoteSession` keeps the row
     * in, and what brings the row back after a restart. It is recorded as
     * the hand-off records a project's copy (stage 3's worktree copies), with
     * `copyOf` from the project the folder
     * lies under (its parent copy), when that one is a copy of a local
     * project, so the local project's page lists it with its other copies.
     *
     * Nothing is recorded for a host that isn't a registered VM with an agent:
     * an agentless remote keeps needing a project the user added, exactly as
     * before. The VM's home itself (`ssh://user@host`, no folder: the setup
     * terminal opened from Settings → VMs) is recorded like any other folder,
     * so it is listed as the VM's home project, which is what keeps that
     * terminal's row, and lets it be reattached after a restart. `home` is the VM
     * user's home folder (the agent's `welcome`), which lets a `~/…` project
     * be found as the parent of the absolute paths git answers; without it,
     * only a parent named in the same form is found.
     *
     * Answers the stored record, the new one, or null when there is none.
     */
    public ensureRemoteProject(projectPath: string, home?: string | null): RemoteProjectSetting | null {
        const found = this.findRemoteProject(projectPath);
        if (found) return found;
        const parsed = parseRemoteProjectPath(projectPath);
        if (!parsed) return null;
        if (!this.findVmHost(parsed)?.agent) return null;
        const onHost = this.remoteProjects().filter((r) => sameHost(r, parsed));

        // No `agent` stored: it is the registration's, read back derived.
        const parent = parentProject(onHost, parsed.dir, home ?? null);
        const record: RemoteProjectSetting = {
            user: parsed.user,
            host: parsed.host,
            port: parsed.port,
            dir: parsed.dir,
            ...(parent?.copyOf ? {copyOf: parent.copyOf} : {}),
        };
        // A path that does not round-trip (a trailing slash, say) would be
        // stored under another name than the one asked for: record nothing.
        if (remoteProjectPath(record) !== projectPath) return null;
        this.addRemoteProject(record);
        return this.findRemoteProject(projectPath);
    }

    public removeRemoteProject(projectPath: string): void {
        this.updateGlobal((settings) => {
            settings.remoteProjects = (settings.remoteProjects || []).filter(
                (r) => remoteProjectPath(r) !== projectPath,
            );
        });
    }

    /**
     * Record that a remote session was opened, creating its record if needed.
     *
     * This is what makes a remote session reappear in the sidebar after a
     * restart — without connecting on its own, which would fire off an ssh that
     * may need interaction the user is not looking at.
     *
     * Returns null when the remote project is no longer configured.
     */
    public touchRemoteSession(
        projectPath: string,
        sessionId: string,
        kind: string,
        nowIso: string,
    ): RemoteSessionRecord | null {
        return this.updateGlobal((settings) => {
            const project = (settings.remoteProjects || []).find((r) => remoteProjectPath(r) === projectPath);
            if (!project) return null;
            project.sessions = project.sessions || [];
            let record = project.sessions.find((s) => s.sessionId === sessionId);
            if (!record) {
                record = {sessionId, kind, created: nowIso};
                project.sessions.push(record);
            }
            record.lastOpened = nowIso;
            return record;
        });
    }

    // ── Hand-off ──
    // The ignored files the user carried on the last hand-off of a project
    // (#276 stage 2), so the next one starts with the same ones ticked. Kept
    // apart from the project's settings blob: it is not a setting anybody
    // edits, and the settings panel need not know about it.

    /** The paths ticked on the last hand-off of `localPath`; null before its first. */
    public handoffFiles(localPath: string): string[] | null {
        const stored = this.store.get<unknown>(handoffFilesKey(localPath));
        return Array.isArray(stored) ? stored.filter((p): p is string => typeof p === 'string') : null;
    }

    public rememberHandoffFiles(localPath: string, paths: readonly string[]): void {
        this.store.set(handoffFilesKey(localPath), [...paths]);
    }

    // ── Handed-off sessions ──
    // A session handed off to a VM (#276 stage 3) by id, with the copy it
    // continues in. Its transcript stays on the Mac; this is what keeps its
    // local row out of the list, so one conversation has one row, the VM's.

    /** Where `sessionId` was handed off to, or null for a session that never was. */
    public handedOffSession(sessionId: string): {copyPath: string; at: string} | null {
        return this.global().handedOffSessions?.[sessionId] ?? null;
    }

    public recordHandedOffSession(sessionId: string, copyPath: string, at: string): void {
        this.updateGlobal((settings) => {
            settings.handedOffSessions = {...settings.handedOffSessions, [sessionId]: {copyPath, at}};
        });
    }

    // ── Where schedules run ──
    // Per local project, the copy on a VM its `schedule-*.md` run in (#276
    // stage 5, Q18); absent means this Mac. Beside it, what the VMs still have
    // to be told, so a change made while a VM was away reaches it on its next
    // connect, and how far each VM's runs have been read. One blob under its
    // own key, like the hand-off's files: nobody edits it in the settings panel.

    /** The whole of it, defaults filled in; a copy, safe to change and pass to `saveVmSchedules`. */
    public vmSchedules(): VmScheduleState {
        const stored = this.store.get<Partial<VmScheduleState>>(VM_SCHEDULES_KEY) ?? {};
        return {
            choices: {...stored.choices},
            pendingMoves: {...stored.pendingMoves},
            pendingRemovals: {...stored.pendingRemovals},
            runsSince: {...stored.runsSince},
        };
    }

    /** Read it, let the caller change it, write it back, as `updateGlobal` does for the global blob. */
    public updateVmSchedules<T>(mutate: (state: VmScheduleState) => T): T {
        const state = this.vmSchedules();
        const result = mutate(state);
        this.store.set(VM_SCHEDULES_KEY, state);
        return result;
    }

    /** The copy `localPath`'s schedules run in, or null when they run on this Mac. */
    public scheduleChoice(localPath: string): ScheduleChoice | null {
        return this.vmSchedules().choices[localPath] ?? null;
    }

    /**
     * Record that the Switchboard agent is installed at `version` on the host
     * `path` is on (#276): any `ssh://` path there, a project's or the VM's own
     * (`vmHostPath`). The record is the VM's registration, made first when the
     * host isn't registered yet (installing from an agentless remote's page
     * registers it); every remote project on the host then reads as a VM
     * project, with its sessions and connection info as they were (user story
     * 13).
     *
     * Returns false for a path that names no host.
     */
    public markAgentInstalled(path: string, version: string, installedAt = new Date().toISOString()): boolean {
        const parsed = parseRemoteProjectPath(path);
        if (!parsed) return false;
        this.vmHosts();
        this.updateGlobal((settings) => {
            const hosts = settings.vmHosts ?? [];
            let vm = findVmHostIn(hosts, parsed);
            if (!vm) {
                vm = {user: parsed.user, host: parsed.host, port: parsed.port, addedAt: installedAt};
                hosts.push(vm);
            }
            vm.agent = {version, installedAt};
            settings.vmHosts = hosts;
        });
        return true;
    }
}

/**
 * The deepest of `remotes` whose folder is `dir` or holds it: the project a
 * new VM folder (a worktree) lies under. Folders are compared as written and,
 * when the VM's home is known, with `~` expanded, since a project may be
 * stored as `~/projects/site` while git names its worktrees absolutely.
 */
function parentProject(
    remotes: readonly RemoteProjectSetting[],
    dir: string | null,
    home: string | null,
): RemoteProjectSetting | null {
    const forms = (d: string | null | undefined): string[] => {
        const raw = normalizeRemoteDir(d) ?? '~';
        const expanded = home ? expandVmHome(raw, home) : null;
        return expanded && expanded !== raw ? [raw, expanded] : [raw];
    };
    const targets = forms(dir);
    let best: {remote: RemoteProjectSetting; depth: number} | null = null;
    for (const remote of remotes) {
        for (const base of forms(remote.dir)) {
            if (!targets.some((target) => target === base || target.startsWith(base + '/'))) continue;
            if (!best || base.length > best.depth) best = {remote, depth: base.length};
        }
    }
    return best?.remote ?? null;
}

/** A VM folder with `~` (or a bare relative folder) anchored at the VM user's home. */
function expandVmHome(dir: string, home: string): string {
    const root = home.replace(/\/+$/, '');
    if (dir === '~') return root;
    if (dir.startsWith('~/')) return root + dir.slice(1);
    if (dir.startsWith('/')) return dir;
    return root + '/' + dir;
}

/** The settings-store key the hand-off's ticked files of a local project are kept under. */
export function handoffFilesKey(localPath: string): string {
    return 'handoff-files:' + localPath;
}

/** The settings-store key where-schedules-run is kept under. */
export const VM_SCHEDULES_KEY = 'vm-schedules';

/** A local project's schedules running in one of its copies on a VM. */
export interface ScheduleChoice {
    /** The copy's project path, `ssh://user@host[:port]/dir`. */
    copyPath: string;
    /** When the VM confirmed it, ISO-8601: the first runs worth listing are after it. */
    at: string;
}

/**
 * Where every local project's schedules run, and what the VMs have yet to be
 * told. Kept so that no schedule runs in two places for longer than it takes
 * the VM that is behind to reconnect.
 */
export interface VmScheduleState {
    /** By local project path; a project absent here runs its schedules on this Mac. */
    choices: Record<string, ScheduleChoice>;
    /**
     * By local project path: a move to that copy the VM could not be told of.
     * Tried again when its host connects; the choice is stored once it confirms.
     */
    pendingMoves: Record<string, string>;
    /**
     * By `agentHostKey`: copy folders (`~` kept) that host must drop from its
     * `scheduleDirs`, and has not yet, because it could not be reached when
     * their schedules moved away.
     */
    pendingRemovals: Record<string, string[]>;
    /** By `agentHostKey`: the newest run already read from that host, epoch ms on the VM's clock. */
    runsSince: Record<string, number>;
}
