/**
 * What the managers' settings need from outside (#412): the Planner's cycle
 * for the snooze menu and the Settings field's "✓ cycle N", and whether a
 * project tags its releases.
 *
 * **Cycles.** The snooze options are worked out from the clock and the cycle
 * today falls in, read from the Planner at the stored URL. A cycle read is
 * kept for the day it was asked for, and a failed read for five minutes, so
 * a Planner that is down costs one wait of at most 5 s (the provider's
 * deadline), not one per menu. Without a Planner URL no request is made and
 * the cycle options are left out.
 *
 * **Releases are tagged.** Detected as any tag in the last 90 days, read
 * with the user's own `gh` from the project's GitHub repository, and kept
 * for an hour. The project's own Yes or No overrides it.
 *
 * Never rejects: what could not be asked answers as not known.
 */
import {gitHubRepository} from '../../domain/project/repo-url';
import {isRemoteProjectPath} from '../../domain/project/remote-target';
import {dayOf} from '../../domain/inbox/cycle';
import {inboxSnoozeOptions} from '../../domain/inbox/snooze';
import {resolvePlannerUrl} from '../../domain/settings/settings';
import {releasesTaggedOverride, resolveReleasesTagged, taggedRecently} from '../../domain/settings/inbox-settings';
import type {Cycle} from '../../domain/inbox/cycle';
import type {InboxSnoozeKind} from '../../domain/inbox/snooze';
import type {Clock} from '../ports/clock';
import type {CycleProvider} from '../ports/cycle-provider';
import type {GitHubCli} from '../ports/github-cli';
import type {GitRemotes} from '../ports/git-remotes';
import type {GitWorkspace} from '../ports/git-workspace';
import type {SettingsService} from './settings-service';

/** How long a failed Planner read is remembered, so a menu does not wait on it again at once. */
export const PLANNER_FAILURE_MS = 5 * 60 * 1000;
/** How long a detected Releases are tagged is kept. */
export const RELEASE_TAGS_CACHE_MS = 60 * 60 * 1000;

/** A snooze option as it crosses IPC: its time as ISO, null for Until it changes. */
export interface SnoozeOptionView {
    kind: InboxSnoozeKind;
    label: string;
    until: string | null;
    cycle: boolean;
}

/** What the project's settings show for Releases are tagged. */
export interface ReleaseTagsView {
    /** `owner/name`, or null when the project has no GitHub repository. */
    repository: string | null;
    /** When its newest tag was made, ISO; null when it has none or it could not be read. */
    latestTagAt: string | null;
    /** What the tags say; null when they could not be read. */
    detected: boolean | null;
    /** The project's own Yes or No; null when it follows the detection. */
    override: boolean | null;
    /** What the Bug manager goes by. */
    tagged: boolean;
}

export interface InboxSettingsServiceDeps {
    settings: Pick<SettingsService, 'global' | 'project'>;
    cycles: CycleProvider;
    github: Pick<GitHubCli, 'latestTag'>;
    git: Pick<GitWorkspace, 'worktreeRoot'>;
    remotes: GitRemotes;
    clock: Clock;
    /** An ssh project without an agent: no git or `gh` to ask. Every ssh project unless given. */
    agentlessRemote?: (projectPath: string) => boolean;
}

interface CachedCycle {
    key: string;
    cycle: Cycle | null;
    /** For a failure: when it may be asked again. A cycle is kept for its day. */
    retryAt: number;
}

export class InboxSettingsService {
    private cachedCycle: CachedCycle | null = null;
    private readonly tags = new Map<string, {at: number; latestTagAt: string | null}>();

    constructor(private readonly deps: InboxSettingsServiceDeps) {}

    /**
     * The cycle the Planner at `url` (the stored one when not given) says
     * today is in, for the Settings field: null when it gave none.
     */
    public async plannerCycle(url?: string): Promise<{number: number} | null> {
        const base = url === undefined ? resolvePlannerUrl(this.deps.settings.global()) : url.trim();
        if (!base) return null;
        const cycle = await this.deps.cycles.cycleOn(base, dayOf(new Date(this.deps.clock.now())));
        return cycle ? {number: cycle.number} : null;
    }

    /** The snooze options open now, with the cycle ones when the Planner answers. */
    public async snoozeOptions(): Promise<SnoozeOptionView[]> {
        const now = new Date(this.deps.clock.now());
        const cycle = await this.todaysCycle(now);
        return inboxSnoozeOptions(now, cycle).map((option) => ({
            kind: option.kind,
            label: option.label,
            until: option.until ? option.until.toISOString() : null,
            cycle: option.cycle,
        }));
    }

    /** Releases are tagged for a project: what was detected, what it says itself, and what counts. */
    public async releaseTags(projectPath: string): Promise<ReleaseTagsView> {
        const project = this.deps.settings.project(projectPath);
        const override = releasesTaggedOverride(project);
        const repository = await this.repositoryOf(projectPath);
        const latest = repository ? await this.latestTag(repository) : null;
        const detected = latest ? taggedRecently(latest.latestTagAt, this.deps.clock.now()) : null;
        return {
            repository,
            latestTagAt: latest?.latestTagAt ?? null,
            detected,
            override,
            tagged: resolveReleasesTagged(project, detected),
        };
    }

    /** Whether the Bug manager may judge events against the project's tags. */
    public async releasesTagged(projectPath: string): Promise<boolean> {
        return (await this.releaseTags(projectPath)).tagged;
    }

    private async todaysCycle(now: Date): Promise<Cycle | null> {
        const url = resolvePlannerUrl(this.deps.settings.global());
        if (!url) return null;
        const day = dayOf(now);
        const key = url + '|' + day;
        const cached = this.cachedCycle;
        if (cached?.key === key && (cached.cycle !== null || now.getTime() < cached.retryAt)) return cached.cycle;
        const cycle = await this.deps.cycles.cycleOn(url, day);
        this.cachedCycle = {key, cycle, retryAt: now.getTime() + PLANNER_FAILURE_MS};
        return cycle;
    }

    private async repositoryOf(projectPath: string): Promise<string | null> {
        if ((this.deps.agentlessRemote ?? isRemoteProjectPath)(projectPath)) return null;
        const root = await this.deps.git.worktreeRoot(projectPath);
        const origin = root ? await this.deps.remotes.originUrl(root) : null;
        return (origin && gitHubRepository(origin)) || null;
    }

    /** The repository's newest tag, kept for an hour; null when it could not be read. */
    private async latestTag(repository: string): Promise<{latestTagAt: string | null} | null> {
        const now = this.deps.clock.now();
        const cached = this.tags.get(repository);
        if (cached && now - cached.at < RELEASE_TAGS_CACHE_MS) return cached;
        const answer = await this.deps.github.latestTag(repository);
        if (!answer) return null;
        const fresh = {at: now, latestTagAt: answer.at};
        this.tags.set(repository, fresh);
        return fresh;
    }
}
