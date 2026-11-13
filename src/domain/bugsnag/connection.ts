/**
 * The Bug manager's connection to Bugsnag as Settings keeps it (#411): which
 * Bugsnag projects are opted in, which local project each is linked to, and
 * the trending thresholds. The token is not here: it lives in the Keychain
 * (Electron safeStorage) and never in the settings blob.
 *
 * Linking is many-to-one: a local project can have several Bugsnag projects
 * (an API and a web app), and a Bugsnag project has at most one local project,
 * which holds by construction since each Bugsnag project stores one link.
 */
import type {BugsnagProject} from './model';

/** One Bugsnag project as stored under `bugsnag.projects` in the global blob. */
export interface BugsnagProjectSetting {
    id: string;
    /** The name last seen from Bugsnag, so later pages can label it without a call. */
    name: string;
    optedIn: boolean;
    /** The local project path it is linked to; null when it isn't linked. */
    localProject: string | null;
}

/** When a bug counts as trending (#409 story 7). */
export interface TrendingThresholds {
    /** Events in the last 24 h at least this many times the 7-day daily average. */
    multiplier: number;
    /** And at least this many events in the last 24 h. */
    minEvents: number;
}

/** The global blob's `bugsnag` key. */
export interface BugsnagSettings {
    projects: BugsnagProjectSetting[];
    trending: TrendingThresholds;
}

/** The global blob's key for the Bug manager's settings. */
export const BUGSNAG_SETTINGS_KEY = 'bugsnag';

export const DEFAULT_TRENDING: TrendingThresholds = {multiplier: 3, minEvents: 20};

/** The bounds the threshold fields accept; a value outside is clamped into them. */
export const TRENDING_LIMITS = {
    multiplier: {min: 1, max: 100},
    minEvents: {min: 1, max: 1_000_000},
} as const;

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

/** A number, or a number typed as text; NaN for anything else, empty included. */
function numberIn(value: unknown): number {
    if (typeof value === 'number') return value;
    return typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
}

/** Thresholds from anything: missing or non-numeric parts fall back to the defaults. */
export function normaliseTrending(value: unknown): TrendingThresholds {
    const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
    const multiplier = numberIn(raw.multiplier);
    const minEvents = numberIn(raw.minEvents);
    return {
        multiplier: Number.isFinite(multiplier)
            ? clamp(Math.round(multiplier * 10) / 10, TRENDING_LIMITS.multiplier.min, TRENDING_LIMITS.multiplier.max)
            : DEFAULT_TRENDING.multiplier,
        minEvents: Number.isFinite(minEvents)
            ? clamp(Math.round(minEvents), TRENDING_LIMITS.minEvents.min, TRENDING_LIMITS.minEvents.max)
            : DEFAULT_TRENDING.minEvents,
    };
}

/** The stored `bugsnag` settings, with defaults filled in and malformed entries dropped. */
export function resolveBugsnagSettings(global: Record<string, unknown> | null | undefined): BugsnagSettings {
    const raw = global?.[BUGSNAG_SETTINGS_KEY];
    const stored = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const projects: BugsnagProjectSetting[] = [];
    const seen = new Set<string>();
    for (const item of Array.isArray(stored.projects) ? stored.projects : []) {
        const entry = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
        if (typeof entry.id !== 'string' || entry.id === '' || seen.has(entry.id)) continue;
        seen.add(entry.id);
        projects.push({
            id: entry.id,
            name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : entry.id,
            optedIn: entry.optedIn === true,
            localProject:
                typeof entry.localProject === 'string' && entry.localProject !== '' ? entry.localProject : null,
        });
    }
    return {projects, trending: normaliseTrending(stored.trending)};
}

/** What a change to one Bugsnag project sets; an absent field is left as it was. */
export interface BugsnagProjectChange {
    optedIn?: boolean;
    /** A local project path, or null to unlink. */
    localProject?: string | null;
}

/**
 * Apply a change to one Bugsnag project. A project not stored yet is added
 * (named `name`, or its id). Linking replaces the project's one link, so it
 * can never point at two local projects.
 */
export function changeProject(
    settings: BugsnagSettings,
    id: string,
    change: BugsnagProjectChange,
    name?: string,
): BugsnagSettings {
    const existing = settings.projects.find((project) => project.id === id);
    const before: BugsnagProjectSetting = existing ?? {id, name: name || id, optedIn: false, localProject: null};
    const after: BugsnagProjectSetting = {
        ...before,
        ...(name ? {name} : {}),
        ...(change.optedIn !== undefined ? {optedIn: change.optedIn} : {}),
        ...(change.localProject !== undefined ? {localProject: change.localProject || null} : {}),
    };
    return {
        ...settings,
        projects: existing
            ? settings.projects.map((project) => (project.id === id ? after : project))
            : [...settings.projects, after],
    };
}

/** Refresh stored names from what Bugsnag lists; nothing is added or removed. */
export function renameFromListed(settings: BugsnagSettings, listed: readonly BugsnagProject[]): BugsnagSettings {
    const names = new Map(listed.map((project) => [project.id, project.name]));
    return {
        ...settings,
        projects: settings.projects.map((project) => {
            const name = names.get(project.id);
            return name && name !== project.name ? {...project, name} : project;
        }),
    };
}

/** The Bugsnag projects linked to a local project, opted in or not. */
export function bugsnagProjectsFor(settings: BugsnagSettings, localProject: string): BugsnagProjectSetting[] {
    return settings.projects.filter((project) => project.localProject === localProject);
}

/** The local project a Bugsnag project is linked to, or null. */
export function localProjectFor(settings: BugsnagSettings, bugsnagProjectId: string): string | null {
    return settings.projects.find((project) => project.id === bugsnagProjectId)?.localProject ?? null;
}

/** One row of the Settings list: a Bugsnag project the token sees, or one stored that it no longer does. */
export interface BugsnagProjectRow {
    id: string;
    name: string;
    optedIn: boolean;
    localProject: string | null;
    /** Stored, but the token no longer sees it. */
    missing: boolean;
}

/**
 * The Settings list: every project the token sees, in Bugsnag's order, with
 * its stored choices, then stored projects it no longer sees. Without a list
 * (no token, or Bugsnag unreachable) the stored ones are shown as they are.
 */
export function projectRows(settings: BugsnagSettings, listed: readonly BugsnagProject[] | null): BugsnagProjectRow[] {
    const stored = new Map(settings.projects.map((project) => [project.id, project]));
    if (listed === null) return settings.projects.map((project) => ({...project, missing: false}));
    const rows: BugsnagProjectRow[] = listed.map((project) => {
        const choice = stored.get(project.id);
        return {
            id: project.id,
            name: project.name,
            optedIn: choice?.optedIn ?? false,
            localProject: choice?.localProject ?? null,
            missing: false,
        };
    });
    const visible = new Set(listed.map((project) => project.id));
    for (const project of settings.projects) {
        if (!visible.has(project.id) && (project.optedIn || project.localProject))
            rows.push({...project, missing: true});
    }
    return rows;
}

/** How a saved token is shown: its last four characters, the rest masked. */
export function maskedToken(lastFour: string): string {
    return '••••••••' + lastFour;
}

/** The last four characters of a token, the only part that ever leaves main. */
export function tokenLastFour(token: string): string {
    return token.trim().slice(-4);
}

/** Why a call to Bugsnag failed, in the terms the user can act on. */
export type BugsnagFailure = 'unauthorized' | 'forbidden' | 'rate-limited' | 'unreachable' | 'unexpected';

/** The line under the token field for a failure. */
export function failureLine(failure: BugsnagFailure): string {
    switch (failure) {
        case 'unauthorized':
            return "Bugsnag didn't accept this token. Use a personal auth token from Bugsnag's My account settings.";
        case 'forbidden':
            return "This token isn't allowed to list projects.";
        case 'rate-limited':
            return 'Bugsnag is limiting requests right now. Try again in a minute.';
        case 'unreachable':
            return "Couldn't reach Bugsnag. Check your connection and try again.";
        case 'unexpected':
            return 'Bugsnag gave an answer Switchboard did not expect. Try again later.';
    }
}

/** The line under the token field when it works. */
export function visibleProjectsLine(count: number): string {
    return `✓ ${count} ${count === 1 ? 'project' : 'projects'} visible`;
}

/** The line shown when the bugsnag MCP isn't in `~/.claude.json`. */
export const BUGSNAG_MCP_HINT =
    'Claude Code has no bugsnag MCP server. Fix sessions need it to link their pull request on the error.';
