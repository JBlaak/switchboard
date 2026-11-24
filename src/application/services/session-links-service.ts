/**
 * A session's links for the session tray (#340): its PRs, the issues it
 * mentioned, the artifacts it published, the pages it showed, the Bugsnag
 * error a Fix session works on and its task, in
 * one answer (`sessionLinks` puts them in order).
 *
 * The tray opens on a hover, so the answer waits on `gh` only once per
 * session, and only when the conversation mentioned issues (they are listed
 * once `gh` confirms them), and never on BlaakTasks. It is laid out from what is kept here, and whatever has gone
 * stale is asked again behind it, for the next hover: the transcript when it
 * was written to, `gh` once a minute or when a new PR or mention turns up,
 * and the task's detail once a minute. The very first answer for a session
 * reads its transcript (and its origin remote) first, which is local; its
 * PRs come without status until `gh` has answered, unless the CI watch
 * already knows them. A PR status from our own `gh` read says how fresh it
 * is (`LinkedPr.read`); when an ask fails, the last good status stays.
 */
import {gitHubRepository, sameRepository} from '../../domain/project/repo-url';
import {isRemoteProjectPath} from '../../domain/project/remote-target';
import {byRepository} from '../../domain/session-work/issues';
import {
    LINKS_GITHUB_TTL_MS,
    sessionLinks,
    type BugLinkFacts,
    type LinksWait,
    type SessionLink,
    type TaskFacts,
} from '../../domain/session/links';
import type {SessionPullRequest} from '../../domain/session/session';
import type {GitHubRead, IssueRef, IssueStatus, PullRequestStatus} from '../../domain/session-work/model';
import type {BlaakTasksResult, TaskDetail} from '../../domain/tasks/model';
import type {Clock} from '../ports/clock';
import type {GitHubCli} from '../ports/github-cli';
import type {GitRemotes} from '../ports/git-remotes';
import type {Logger} from '../ports/logger';
import type {AwaitableTranscriptStore} from '../ports/transcript-queries';
import type {TranscriptProducts} from '../ports/transcript-store';

export {LINKS_GITHUB_TTL_MS, type LinksWait};

/** How long a task's detail is used before BlaakTasks is asked again. */
export const LINKS_TASK_TTL_MS = 60_000;

/** How long a transcript read is used when there is no fingerprint to tell a change by (a VM session). */
export const LINKS_TRANSCRIPT_TTL_MS = 60_000;

/** Where a session's transcripts live and the directory it was started in. */
export interface SessionLinksTarget {
    /** The transcript folder; null when the session has none yet. */
    folder: string | null;
    projectPath: string;
}

export interface SessionLinksServiceDeps {
    /** Where a session lives, or null when no session goes by that id. */
    locate(sessionId: string): SessionLinksTarget | null;
    /** The session's PRs from its transcript's `pr-link` lines, chronological: the sidebar row's, already read. */
    pullRequests(sessionId: string): readonly SessionPullRequest[];
    transcripts: Pick<AwaitableTranscriptStore, 'issueMentions' | 'products' | 'sessionFingerprint'>;
    remotes: GitRemotes;
    github: Pick<GitHubCli, 'available' | 'pullRequests' | 'issues'>;
    /** What the CI watch last heard about a PR, by URL: fresher than ours for a running session. */
    watchedStatus?(url: string): PullRequestStatus | null;
    /** The session's BlaakTasks task, and a task's detail; `sessionTask` answers null while BlaakTasks is off. */
    tasks: {
        sessionTask(sessionId: string): string | null;
        get(taskId: string): Promise<BlaakTasksResult<TaskDetail>>;
    };
    /** The Bugsnag error a Fix session in this worktree works on, from what is known now; null for any other. */
    bug?(projectPath: string): BugLinkFacts | null;
    /** Whether a path is on a remote with no Switchboard agent: no git to ask its origin. */
    agentlessRemote?: (path: string) => boolean;
    clock: Clock;
    log: Logger;
}

/** What the transcript said, as of `fingerprint`. */
interface TranscriptFacts {
    fingerprint: string | null;
    at: number;
    mentions: IssueRef[];
    products: TranscriptProducts;
}

/** What `gh` said, for the PRs and mentions in `key`. */
interface GitHubFacts {
    at: number;
    key: string;
    /** Null when `gh` is missing or signed out; the last good status where a later ask failed. */
    pullRequests: PullRequestStatus[] | null;
    /** How fresh `pullRequests` is; null when it is null or no PR was asked about. */
    pullRequestsRead: GitHubRead | null;
    issues: Map<string, IssueStatus[] | null> | null;
}

interface Entry {
    target: SessionLinksTarget | null;
    /** `owner/repo`; null until looked up. */
    repository: string | null;
    transcript: TranscriptFacts | null;
    github: GitHubFacts | null;
    refreshing: Promise<void> | null;
    /** A refresh was asked for while one ran: look once more after it. */
    again: boolean;
}

const NO_PRODUCTS: TranscriptProducts = {artifacts: [], pages: []};

export class SessionLinksService {
    private readonly entries = new Map<string, Entry>();
    private readonly tasks = new Map<string, {at: number; detail: TaskFacts['detail']}>();

    constructor(private readonly deps: SessionLinksServiceDeps) {}

    /**
     * The session's links, from what is known now. Anything stale is asked
     * again behind the answer (see `refresh`), so the next call has it.
     *
     * `wait` says what the answer waits for besides the transcript:
     * - `issues` (the default): `gh`, once, for a session that mentioned
     *   issues, since they only list once `gh` has confirmed them;
     * - `nothing`: never `gh` or BlaakTasks, for an answer as soon as can be;
     * - `everything`: whatever is stale, asked again first, so the answer is
     *   as fresh as it gets (the tray's second answer, after a `nothing`).
     */
    public async links(sessionId: string, wait: LinksWait = 'issues'): Promise<SessionLink[]> {
        const entry = this.entry(sessionId);
        if (!entry.transcript) await this.readTranscript(sessionId, entry);
        const firstWithMentions = !entry.github && (entry.transcript?.mentions.length ?? 0) > 0;
        if (wait === 'everything' && (entry.refreshing || this.isStale(sessionId, entry)))
            await this.refresh(sessionId);
        else if (wait === 'issues' && firstWithMentions) await this.refresh(sessionId);
        else if (this.isStale(sessionId, entry)) void this.refresh(sessionId);
        return this.assemble(sessionId, entry);
    }

    /**
     * Ask again whatever is stale for this session: its transcript, `gh` and
     * its task. One at a time per session: a call while one runs looks again
     * once it is done, since the transcript may have been written to since.
     */
    public refresh(sessionId: string): Promise<void> {
        const entry = this.entry(sessionId);
        if (entry.refreshing) {
            entry.again = true;
            return entry.refreshing;
        }
        entry.refreshing = (async () => {
            do {
                entry.again = false;
                try {
                    if (this.transcriptStale(sessionId, entry)) await this.readTranscript(sessionId, entry);
                    if (this.githubStale(sessionId, entry)) await this.askGitHub(sessionId, entry);
                    const taskId = this.deps.tasks.sessionTask(sessionId);
                    if (taskId && this.taskStale(taskId)) await this.fetchTask(taskId);
                } catch (err) {
                    this.deps.log.error('[session-links] refreshing failed:', (err as Error).message);
                }
            } while (entry.again);
        })().finally(() => {
            entry.refreshing = null;
        });
        return entry.refreshing;
    }

    // ── What is kept ──

    private entry(sessionId: string): Entry {
        const target = this.deps.locate(sessionId);
        let entry = this.entries.get(sessionId);
        if (!entry) {
            entry = {target, repository: null, transcript: null, github: null, refreshing: null, again: false};
            this.entries.set(sessionId, entry);
        } else if (!sameTarget(entry.target, target)) {
            // Its transcript turned up (or moved): read it afresh.
            entry.target = target;
            entry.repository = null;
            entry.transcript = null;
        }
        return entry;
    }

    private assemble(sessionId: string, entry: Entry): SessionLink[] {
        const pullRequests = this.deps.pullRequests(sessionId);
        const taskId = this.deps.tasks.sessionTask(sessionId);
        const ours = new Set<PullRequestStatus>(entry.github?.pullRequests ?? []);
        const statuses = this.pullRequestStatuses(pullRequests, entry.github);
        const read = entry.github?.pullRequestsRead ?? null;
        // Only a status from our own read says how fresh it is; the CI watch's is live.
        const ourUrls = new Set((statuses ?? []).filter((status) => ours.has(status)).map((status) => status.url));
        const links = sessionLinks({
            repository: entry.repository ?? '',
            pullRequests,
            pullRequestStatuses: statuses,
            issueMentions: entry.transcript?.mentions ?? [],
            issueStatuses: entry.github?.issues ?? null,
            artifacts: entry.transcript?.products.artifacts ?? [],
            pages: entry.transcript?.products.pages ?? [],
            bug: entry.target ? (this.deps.bug?.(entry.target.projectPath) ?? null) : null,
            task: taskId ? {id: taskId, detail: this.tasks.get(taskId)?.detail ?? null} : null,
        });
        if (!read) return links;
        return links.map((link) =>
            link.kind === 'pr' && link.status && ourUrls.has(link.url) ? {...link, read} : link,
        );
    }

    /** The CI watch's answer for each PR where it has one, ours otherwise; null when neither knows any. */
    private pullRequestStatuses(
        pullRequests: readonly SessionPullRequest[],
        github: GitHubFacts | null,
    ): PullRequestStatus[] | null {
        const ours = new Map((github?.pullRequests ?? []).map((status) => [status.url, status]));
        const statuses: PullRequestStatus[] = [];
        for (const pr of pullRequests) {
            const status = this.deps.watchedStatus?.(pr.url) ?? ours.get(pr.url);
            if (status && !statuses.includes(status)) statuses.push(status);
        }
        return statuses.length > 0 || github?.pullRequests ? statuses : null;
    }

    // ── What is stale ──

    private isStale(sessionId: string, entry: Entry): boolean {
        const taskId = this.deps.tasks.sessionTask(sessionId);
        return (
            this.transcriptStale(sessionId, entry) ||
            this.githubStale(sessionId, entry) ||
            (taskId !== null && this.taskStale(taskId))
        );
    }

    private transcriptStale(sessionId: string, entry: Entry): boolean {
        const known = entry.transcript;
        if (!known) return true;
        const folder = entry.target?.folder;
        if (!folder) return false;
        const fingerprint = this.deps.transcripts.sessionFingerprint(folder, sessionId);
        if (fingerprint === null) return this.deps.clock.now() - known.at >= LINKS_TRANSCRIPT_TTL_MS;
        return fingerprint !== known.fingerprint;
    }

    private githubStale(sessionId: string, entry: Entry): boolean {
        const known = entry.github;
        if (!known) return true;
        if (known.key !== this.githubKey(sessionId, entry)) return true;
        return this.deps.clock.now() - known.at >= LINKS_GITHUB_TTL_MS;
    }

    private taskStale(taskId: string): boolean {
        const known = this.tasks.get(taskId);
        return !known || this.deps.clock.now() - known.at >= LINKS_TASK_TTL_MS;
    }

    /** The PRs and mentions an answer from `gh` is for: a new one asks again. */
    private githubKey(sessionId: string, entry: Entry): string {
        const repository = entry.repository ?? '';
        const prs = this.deps.pullRequests(sessionId).map((pr) => pr.url);
        const mentions = (entry.transcript?.mentions ?? []).map(
            (issue) => (issue.repository || repository) + '#' + issue.number,
        );
        return [...prs.sort(), '|', ...mentions.sort()].join('\n');
    }

    // ── Asking ──

    private async readTranscript(sessionId: string, entry: Entry): Promise<void> {
        const {transcripts} = this.deps;
        const target = entry.target;
        if (entry.repository === null) entry.repository = target ? await this.repository(target.projectPath) : '';
        const folder = target?.folder;
        if (!folder) {
            entry.transcript = {fingerprint: null, at: this.deps.clock.now(), mentions: [], products: NO_PRODUCTS};
            return;
        }
        const fingerprint = transcripts.sessionFingerprint(folder, sessionId);
        const mentions = await transcripts.issueMentions(folder, sessionId, entry.repository);
        const products = transcripts.products(folder, sessionId);
        entry.transcript = {fingerprint, at: this.deps.clock.now(), mentions, products};
    }

    private async repository(projectPath: string): Promise<string> {
        if ((this.deps.agentlessRemote ?? isRemoteProjectPath)(projectPath)) return '';
        try {
            const origin = await this.deps.remotes.originUrl(projectPath);
            return origin ? gitHubRepository(origin) : '';
        } catch {
            return '';
        }
    }

    private async askGitHub(sessionId: string, entry: Entry): Promise<void> {
        const {github, clock} = this.deps;
        const key = this.githubKey(sessionId, entry);
        const repository = entry.repository ?? '';
        if ((await github.available()) !== 'ok') {
            entry.github = {at: clock.now(), key, pullRequests: null, pullRequestsRead: null, issues: null};
            return;
        }
        const known = entry.github;
        const pullRequests: PullRequestStatus[] = [];
        const repositories = byRepository(this.deps.pullRequests(sessionId), repository);
        let failed = false;
        for (const [repo, numbers] of repositories) {
            const answer = await github.pullRequests(repo, numbers);
            if (answer === null) {
                failed = true;
                // A failed ask keeps the last good status of this repository's PRs, marked as old.
                const wanted = new Set(numbers);
                for (const status of known?.pullRequests ?? []) {
                    if (sameRepository(status.repository || repository, repo) && wanted.has(status.number))
                        pullRequests.push(status);
                }
            } else pullRequests.push(...answer);
        }
        const pullRequestsRead: GitHubRead | null =
            repositories.size === 0
                ? null
                : {fetchedAt: failed ? (known?.pullRequestsRead?.fetchedAt ?? null) : clock.now(), failed};
        const issues = new Map<string, IssueStatus[] | null>();
        for (const [repo, numbers] of byRepository(entry.transcript?.mentions ?? [], repository)) {
            issues.set(repo, await github.issues(repo, numbers));
        }
        entry.github = {at: clock.now(), key, pullRequests, pullRequestsRead, issues};
    }

    private async fetchTask(taskId: string): Promise<void> {
        const result = await this.deps.tasks.get(taskId);
        const known = this.tasks.get(taskId)?.detail ?? null;
        const detail =
            result.kind === 'ok'
                ? {title: result.value.title, url: result.value.url, status: result.value.status}
                : known;
        this.tasks.set(taskId, {at: this.deps.clock.now(), detail});
    }
}

function sameTarget(a: SessionLinksTarget | null, b: SessionLinksTarget | null): boolean {
    return a?.folder === b?.folder && a?.projectPath === b?.projectPath;
}
