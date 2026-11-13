/**
 * The Bug manager's connection to Bugsnag (#411): the token, which projects
 * are opted in and linked, and the trending thresholds, for Settings → Bug
 * manager; and the API on the saved token, for the pollers that come later.
 *
 * The token is tried before it is saved, saved through the SecretStore (the
 * Keychain) and never written to settings, logged or handed back: what the
 * renderer gets is a `BugsnagConnectionView`, which only ever holds its last
 * four characters.
 */
import {
    BUGSNAG_SETTINGS_KEY,
    changeProject,
    failureLine,
    normaliseTrending,
    projectRows,
    renameFromListed,
    resolveBugsnagSettings,
    tokenLastFour,
    visibleProjectsLine,
} from '../../domain/bugsnag/connection';
import {BugsnagApiError} from '../ports/bugsnag-api';
import type {
    BugsnagProjectChange,
    BugsnagProjectRow,
    BugsnagSettings,
    TrendingThresholds,
} from '../../domain/bugsnag/connection';
import type {BugsnagProject} from '../../domain/bugsnag/model';
import type {BugsnagApi, BugsnagApiFactory} from '../ports/bugsnag-api';
import type {Logger} from '../ports/logger';
import type {McpServers} from '../ports/mcp-servers';
import type {SecretStore} from '../ports/secret-store';
import type {SettingsService} from './settings-service';

/** The SecretStore name the token is kept under. */
export const BUGSNAG_TOKEN_SECRET = 'bugsnag-token';

/** A local project a Bugsnag project can be linked to. */
export interface LocalProjectChoice {
    path: string;
    name: string;
}

/** Settings → Bug manager, as main tells the renderer. Never the token itself. */
export interface BugsnagConnectionView {
    /** The saved token's last four characters; null when none is saved. */
    tokenLastFour: string | null;
    /** What trying the token said: "✓ N projects visible", or the error in plain words. Null without a token. */
    status: {ok: true; line: string; projectCount: number} | {ok: false; line: string} | null;
    projects: BugsnagProjectRow[];
    localProjects: LocalProjectChoice[];
    trending: TrendingThresholds;
    /** Whether `~/.claude.json` lacks a `bugsnag` server, which Fix sessions need. */
    mcpMissing: boolean;
}

export interface BugsnagConnectionDeps {
    secrets: SecretStore;
    api: BugsnagApiFactory;
    settings: SettingsService;
    mcpServers: Pick<McpServers, 'has'>;
    /** The local projects to offer for linking. */
    localProjects: () => LocalProjectChoice[];
    log: Logger;
}

export class BugsnagConnectionService {
    constructor(private readonly deps: BugsnagConnectionDeps) {}

    /** The API on the saved token, or null when none is saved. */
    public api(): BugsnagApi | null {
        const token = this.token();
        return token ? this.deps.api(token) : null;
    }

    /** The stored settings, defaults filled in. */
    public settings(): BugsnagSettings {
        return resolveBugsnagSettings(this.deps.settings.global());
    }

    /** Settings → Bug manager as it stands, asking Bugsnag for the projects the token sees. */
    public async view(): Promise<BugsnagConnectionView> {
        const token = this.token();
        if (!token) return this.viewFor(null, null, null);
        return this.viewAfterTrying(token);
    }

    /**
     * Try a token and keep it only when Bugsnag accepts it. A refused or
     * unreachable try leaves the saved token as it was and says why.
     */
    public async saveToken(token: string): Promise<BugsnagConnectionView> {
        const candidate = token.trim();
        if (!candidate) return this.view();
        const tried = await this.tryToken(candidate);
        if (!tried.ok) {
            const saved = this.token();
            return this.viewFor(saved ? tokenLastFour(saved) : null, {ok: false, line: tried.line}, null);
        }
        this.deps.secrets.write(BUGSNAG_TOKEN_SECRET, candidate);
        this.deps.log.info(`[bugsnag] token saved, ${tried.projects.length} projects visible`);
        this.rememberNames(tried.projects);
        return this.viewFor(tokenLastFour(candidate), okStatus(tried.projects), tried.projects);
    }

    /** Forget the token. The opted-in projects and links stay for when one is saved again. */
    public removeToken(): BugsnagConnectionView {
        this.deps.secrets.remove(BUGSNAG_TOKEN_SECRET);
        this.deps.log.info('[bugsnag] token removed');
        return this.viewFor(null, null, null);
    }

    /** Opt a Bugsnag project in or out, or link it to a local project (or unlink it with null). */
    public setProject(id: string, change: BugsnagProjectChange, name?: string): BugsnagSettings {
        const localProject = change.localProject;
        if (localProject && !this.deps.localProjects().some((project) => project.path === localProject)) {
            throw new Error(`not a local project: ${localProject}`);
        }
        return this.update((settings) => changeProject(settings, id, change, name));
    }

    /** Store the trending thresholds, normalised. */
    public setTrending(trending: unknown): TrendingThresholds {
        return this.update((settings) => ({...settings, trending: normaliseTrending(trending)})).trending;
    }

    private token(): string | null {
        const token = this.deps.secrets.read(BUGSNAG_TOKEN_SECRET)?.trim();
        return token ? token : null;
    }

    private async viewAfterTrying(token: string): Promise<BugsnagConnectionView> {
        const tried = await this.tryToken(token);
        if (!tried.ok) return this.viewFor(tokenLastFour(token), {ok: false, line: tried.line}, null);
        this.rememberNames(tried.projects);
        return this.viewFor(tokenLastFour(token), okStatus(tried.projects), tried.projects);
    }

    private async tryToken(token: string): Promise<{ok: true; projects: BugsnagProject[]} | {ok: false; line: string}> {
        try {
            return {ok: true, projects: await this.deps.api(token).listProjects()};
        } catch (err) {
            const failure = err instanceof BugsnagApiError ? err.failure : 'unexpected';
            this.deps.log.warn(`[bugsnag] listing projects failed: ${failure}`);
            return {ok: false, line: failureLine(failure)};
        }
    }

    private viewFor(
        lastFour: string | null,
        status: BugsnagConnectionView['status'],
        listed: BugsnagProject[] | null,
    ): BugsnagConnectionView {
        const settings = this.settings();
        return {
            tokenLastFour: lastFour,
            status,
            projects: projectRows(settings, listed),
            localProjects: this.deps.localProjects(),
            trending: settings.trending,
            mcpMissing: !this.deps.mcpServers.has('bugsnag'),
        };
    }

    private rememberNames(listed: BugsnagProject[]): void {
        const before = this.settings();
        const after = renameFromListed(before, listed);
        if (after !== before && after.projects.some((project, i) => project !== before.projects[i])) {
            this.update(() => after);
        }
    }

    private update(change: (settings: BugsnagSettings) => BugsnagSettings): BugsnagSettings {
        return this.deps.settings.updateGlobal((global) => {
            const next = change(resolveBugsnagSettings(global));
            global[BUGSNAG_SETTINGS_KEY] = next;
            return next;
        });
    }
}

function okStatus(projects: BugsnagProject[]): BugsnagConnectionView['status'] {
    return {ok: true, line: visibleProjectsLine(projects.length), projectCount: projects.length};
}
