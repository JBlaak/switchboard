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
import {remoteProjectPath} from '../../domain/project/remote-target';
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
