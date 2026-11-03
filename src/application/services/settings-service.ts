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
    resolveWeatherEnabled,
    resolveWeatherLocation,
} from '../../domain/settings/settings';
import {normalizeRemoteDir, parseRemoteProjectPath, remoteProjectPath} from '../../domain/project/remote-target';
import type {EffectiveSettings, GlobalSettings, RemoteProjectSetting} from '../../domain/settings/settings';
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

    // ── Remote projects ──
    // Stored in settings rather than derived from the transcript directory: the
    // session history lives on the remote host, so the only local state is the
    // connection info and which tmux sessions we created.

    public remoteProjects(): RemoteProjectSetting[] {
        return this.global().remoteProjects || [];
    }

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
     * the hand-off records a project's copy (stage 3's worktree copies):
     * `agent` copied from the host, and `copyOf` from the project the folder
     * lies under (its parent copy), when that one is a copy of a local
     * project, so the local project's page lists it with its other copies.
     *
     * Nothing is recorded for a host with no agent: an agentless remote keeps
     * needing a project the user added, exactly as before. `home` is the VM
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
        const onHost = this.remoteProjects().filter(
            (r) => r.user === parsed.user && r.host === parsed.host && (Number(r.port) || 22) === parsed.port,
        );
        const withAgent = onHost.find((r) => r.agent);
        if (!withAgent?.agent) return null;

        const parent = parentProject(onHost, parsed.dir, home ?? null);
        const agent = parent?.agent ?? withAgent.agent;
        const record: RemoteProjectSetting = {
            user: parsed.user,
            host: parsed.host,
            port: parsed.port,
            dir: parsed.dir,
            agent: {...agent},
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

    /**
     * Record that the Switchboard agent is installed on this remote's host at
     * `version` (#276), which makes it a VM project.
     *
     * Only the `agent` field changes: the remote's sessions and connection info
     * stay as they were, so installing the agent on a remote already in use
     * costs nothing (user story 13). Only the named project is marked, even
     * when other remote projects point at the same host; whether those follow
     * is the caller's decision.
     *
     * Returns false when the remote project is no longer configured.
     */
    public markAgentInstalled(projectPath: string, version: string, installedAt = new Date().toISOString()): boolean {
        return this.updateGlobal((settings) => {
            const remotes = settings.remoteProjects || [];
            const project = remotes.find((r) => remoteProjectPath(r) === projectPath);
            if (!project) return false;
            // The agent serves the whole host, so every remote on it (another
            // folder on the same VM) becomes a VM project with it.
            for (const remote of remotes) {
                if (remote.user === project.user && remote.host === project.host && remote.port === project.port) {
                    remote.agent = {version, installedAt};
                }
            }
            return true;
        });
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
