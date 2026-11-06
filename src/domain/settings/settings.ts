/**
 * Settings, and how a global default and a per-project override combine.
 *
 * Settings live in two blobs — one `global`, one per project — and every
 * consumer wants the resolved value rather than both halves. The merge rule and
 * the defaults it fills from are here so the launch path, the settings panel
 * and the scheduler all resolve a value the same way.
 */
import type {RemoteConfig} from '../project/remote-target';
import type {RemoteSessionRecord} from '../session/session';
import type {AppIcon} from './app-icon';
import type {Appearance} from './appearance';
import {DEFAULT_WEATHER_LOCATION, parseWeatherLocation} from '../weather/weather';
import type {WeatherLocation} from '../weather/weather';

/**
 * The `global` settings blob.
 *
 * Open-ended on purpose: the settings panel writes arbitrary per-feature keys,
 * and only the ones read in code need to be named.
 */
export interface GlobalSettings {
    hiddenProjects?: string[];
    remoteProjects?: RemoteProjectSetting[];
    /** The registered VMs (Settings → VMs). */
    vmHosts?: VmHostSetting[];
    /**
     * Sessions handed off to a VM (#276 stage 3), by id: the copy's project
     * path they continue in. Their transcript on the Mac stays on disk, and
     * this keeps its local row out of the list, so one conversation has one
     * row: the VM's.
     */
    handedOffSessions?: Record<string, {copyPath: string; at: string}>;
    windowBounds?: WindowBounds;
    /**
     * Global only, never per project: it is one window's colour scheme. Read it
     * through `normaliseAppearance`, which supplies the 'system' default.
     */
    appearance?: Appearance;
    /**
     * Global only. Whether the empty screen fetches the weather at all; read it
     * through `resolveWeatherEnabled`, which supplies the `true` default.
     */
    weatherEnabled?: boolean;
    /**
     * Global only. Where the weather is fetched for; read it through
     * `resolveWeatherLocation`, which supplies Amsterdam.
     */
    weatherLocation?: WeatherLocation;
    /**
     * Global only. Whether ⌥Space opens Quick Ask; read it through
     * `resolveQuickAskEnabled`, which supplies the `true` default.
     */
    quickAsk?: boolean;
    /**
     * Global only. Whether archiving a session removes the worktrees it worked
     * in; read it through `resolveRemoveWorktreeOnArchive`, which supplies the
     * `false` default.
     */
    removeWorktreeOnArchive?: boolean;
    /**
     * Global only. Whether the local sessions that were running when
     * Switchboard quit, crashed or the Mac restarted are resumed when it starts
     * again; read it through `resolveRestoreSessions`, which supplies the
     * `true` default.
     */
    restoreSessions?: boolean;
    /**
     * Global only. Which icon the running app shows in the Dock; read it through
     * `normaliseAppIcon`, which supplies 'switchboard'.
     */
    appIcon?: AppIcon;
    /**
     * Global only. The BlaakTasks MCP address, e.g. `https://tasks.example.com/mcp`:
     * the one switch for every part of Switchboard that talks to BlaakTasks
     * (#244). Empty, the default, keeps it all off. Read it through
     * `resolveBlaakTasksUrl`.
     */
    blaakTasksUrl?: string;
    [key: string]: unknown;
}

/**
 * A VM registered in Settings → VMs (#276, after stage 5), as a paired phone
 * is in Settings → Phone access: the host itself, with no folder. It is the
 * source of truth for which hosts run a Switchboard agent; a remote project
 * on a registered host with an agent is a VM project.
 */
export interface VmHostSetting {
    user: string;
    host: string;
    port: number;
    /** What the VM is called in the UI; the `user@host` label when absent. */
    name?: string;
    /** When it was registered, ISO. */
    addedAt: string;
    /** The agent installed on it; absent until an install finished. */
    agent?: {version: string; installedAt: string};
}

/** A remote project as stored in the `global` settings blob. */
export interface RemoteProjectSetting extends RemoteConfig {
    sessions?: RemoteSessionRecord[];
    /**
     * The agent on this project's host (#276): its sessions then run on the
     * agent instead of in tmux. Absent on an agentless remote.
     *
     * Since VMs are registered on their own (`vmHosts`), this is derived: the
     * settings service fills it in from the host's registration when it reads
     * remote projects, and a stored value is only what older builds wrote.
     */
    agent?: {version: string; installedAt: string};
    /**
     * For a project copy a hand-off made (#276 stage 2): the local project it is
     * a copy of. The local project's page lists its copies by this.
     */
    copyOf?: string;
}

/** Persisted window geometry. */
export interface WindowBounds {
    x?: number;
    y?: number;
    width: number;
    height: number;
}

/** The key the global blob is stored under. */
export const GLOBAL_SETTINGS_KEY = 'global';

/** The key a project's overrides are stored under. */
export function projectSettingsKey(projectPath: string): string {
    return 'project:' + projectPath;
}

/**
 * Every setting with a resolved default.
 *
 * A key absent here is still readable through the index signature on
 * EffectiveSettings — this list is what `get-effective-settings` guarantees a
 * value for, which is what lets the launch path read `settings.shellProfile`
 * without a fallback at every use.
 */
export const SETTING_DEFAULTS = {
    permissionMode: null,
    dangerouslySkipPermissions: false,
    worktree: false,
    chrome: false,
    preLaunchCmd: '',
    addDirs: '',
    visibleSessionCount: 25,
    sidebarWidth: 340,
    terminalTheme: 'switchboard',
    terminalFontFamily: '',
    terminalFontSize: 12,
    terminalLineHeight: 1,
    shellProfile: 'auto',
} as const;

/**
 * A project's settings with global defaults already applied.
 *
 * The index signature covers keys a newer build writes that this one does not
 * know about yet.
 */
export interface EffectiveSettings {
    permissionMode?: string | null;
    dangerouslySkipPermissions?: boolean;
    worktree?: boolean;
    chrome?: boolean;
    preLaunchCmd?: string;
    addDirs?: string;
    visibleSessionCount?: number;
    sidebarWidth?: number;
    terminalTheme?: string;
    terminalFontFamily?: string;
    terminalFontSize?: number;
    terminalLineHeight?: number;
    shellProfile?: string;
    [key: string]: unknown;
}

/**
 * Layer defaults, then global, then the project's own overrides.
 *
 * `null` and `undefined` both mean "not set" at every layer: the settings panel
 * writes null to clear a value back to the one inherited from above, so a null
 * must not shadow the layer beneath it.
 */
export function mergeEffectiveSettings(
    global: Record<string, unknown> | null | undefined,
    project: Record<string, unknown> | null | undefined,
): EffectiveSettings {
    const effective: Record<string, unknown> = {...SETTING_DEFAULTS};
    for (const key of Object.keys(SETTING_DEFAULTS)) {
        const fromGlobal = global?.[key];
        if (fromGlobal !== undefined && fromGlobal !== null) effective[key] = fromGlobal;
        const fromProject = project?.[key];
        if (fromProject !== undefined && fromProject !== null) effective[key] = fromProject;
    }
    return effective;
}

/** The shell profile id a project should launch in. */
export function resolveShellProfileId(
    global: Record<string, unknown> | null | undefined,
    project?: Record<string, unknown> | null,
): string {
    let profileId: string = SETTING_DEFAULTS.shellProfile;
    const fromGlobal = global?.shellProfile;
    if (fromGlobal !== undefined && fromGlobal !== null) profileId = String(fromGlobal);
    const fromProject = project?.shellProfile;
    if (fromProject !== undefined && fromProject !== null) profileId = String(fromProject);
    return profileId;
}

/** Whether to fetch the weather. On unless switched off explicitly. */
export function resolveWeatherEnabled(global: Record<string, unknown> | null | undefined): boolean {
    return global?.weatherEnabled !== false;
}

/** Whether ⌥Space opens Quick Ask. On unless switched off explicitly (H2). */
export function resolveQuickAskEnabled(global: Record<string, unknown> | null | undefined): boolean {
    return global?.quickAsk !== false;
}

/** Whether archiving a session removes its worktrees. Off unless switched on explicitly. */
export function resolveRemoveWorktreeOnArchive(global: Record<string, unknown> | null | undefined): boolean {
    return global?.removeWorktreeOnArchive === true;
}

/** Whether to bring running sessions back after a restart. On unless switched off explicitly. */
export function resolveRestoreSessions(global: Record<string, unknown> | null | undefined): boolean {
    return global?.restoreSessions !== false;
}

/** The BlaakTasks address, trimmed; '' while BlaakTasks is off, which it is unless one is entered. */
export function resolveBlaakTasksUrl(global: Record<string, unknown> | null | undefined): string {
    const url = global?.blaakTasksUrl;
    return typeof url === 'string' ? url.trim() : '';
}

/** Where to fetch the weather for: the stored location if it is a valid one. */
export function resolveWeatherLocation(global: Record<string, unknown> | null | undefined): WeatherLocation {
    return parseWeatherLocation(global?.weatherLocation) ?? DEFAULT_WEATHER_LOCATION;
}
