/**
 * Settings, and how a global default and a per-project override combine.
 *
 * Settings live in two blobs — one `global`, one per project — and every
 * consumer wants the resolved value rather than both halves. The merge rule and
 * the defaults it fills from are here so the launch path, the settings panel
 * and the scheduler all resolve a value the same way.
 */
import type { RemoteConfig } from '../project/remote-target';
import type { RemoteSessionRecord } from '../session/session';

/**
 * The `global` settings blob.
 *
 * Open-ended on purpose: the settings panel writes arbitrary per-feature keys,
 * and only the ones read in code need to be named.
 */
export interface GlobalSettings {
  hiddenProjects?: string[];
  remoteProjects?: RemoteProjectSetting[];
  windowBounds?: WindowBounds;
  [key: string]: unknown;
}

/** A remote project as stored in the `global` settings blob. */
export interface RemoteProjectSetting extends RemoteConfig {
  sessions?: RemoteSessionRecord[];
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
  worktreeName: '',
  chrome: false,
  preLaunchCmd: '',
  addDirs: '',
  visibleSessionCount: 5,
  sidebarWidth: 340,
  terminalTheme: 'switchboard',
  terminalFontFamily: '',
  terminalFontSize: 12,
  terminalLineHeight: 1,
  mcpEmulation: false,
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
  worktreeName?: string;
  chrome?: boolean;
  preLaunchCmd?: string;
  addDirs?: string;
  visibleSessionCount?: number;
  sidebarWidth?: number;
  terminalTheme?: string;
  terminalFontFamily?: string;
  terminalFontSize?: number;
  terminalLineHeight?: number;
  mcpEmulation?: boolean;
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
  const effective: Record<string, unknown> = { ...SETTING_DEFAULTS };
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
