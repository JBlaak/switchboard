/**
 * A session's links (#340): what it produced or refers to, for the session
 * tray's Links group (#338).
 *
 * Six sources each know one kind: the transcript's `pr-link` lines (with
 * `gh` for how each PR is doing), the issues the conversation mentions, the
 * claude.ai artifacts it published, the pages it showed with `show_page`, the
 * Bugsnag error a Fix session works on, and the BlaakTasks task it is linked
 * to. This puts them in one list, PRs first, then issues, artifacts, pages,
 * the bug and the task, each kind newest first.
 *
 * PRs and issues go through the Session work page's own rules
 * (`deriveWorkItems`), so a PR in another repository that `gh` does not know
 * is left out, a PR is never also an issue, and an issue a PR closes shows
 * under that PR rather than on its own, here as there. Unlike that page, a
 * mention is only listed once `gh` has confirmed it is an issue.
 */
import {confirmedIssues} from '../session-work/issues';
import {deriveWorkItems} from '../session-work/items';
import {statusDot, type StatusDot} from '../session-work/status';
import {pullRequestLabel} from './pull-requests';
import type {IssueRef, IssueStatus, PullRequestStatus} from '../session-work/model';
import type {TaskStatus} from '../tasks/model';
import type {ArtifactRef} from './artifacts';
import type {ShownPageRef} from './page-tool';
import type {SessionPullRequest} from './session';

/** The kinds of link, in the order the list gives them. */
export type SessionLinkKind = 'pr' | 'issue' | 'artifact' | 'page' | 'bug' | 'task';

/** How a PR is doing, once `gh` has said. */
export interface LinkedPrStatus {
    state: 'open' | 'draft' | 'merged' | 'closed';
    /** Its checks taken together: any failing, else any pending, else passing; `none` without checks. */
    checks: 'passing' | 'pending' | 'failing' | 'none';
    /** The sidebar chip's colour for it (`statusDot`). */
    dot: StatusDot;
    /**
     * The user `gh` signs in as opened it, for Land it (#436). A PR a session
     * opened is taken as yours until GitHub says otherwise.
     */
    mine: boolean;
}

/** A pull request the session opened or linked. */
export interface LinkedPr {
    kind: 'pr';
    /** Unique in the list and stable across answers: `pr:<url>`. */
    key: string;
    /** GitHub's title once `gh` has said, else `owner/repo#12`. */
    title: string;
    url: string;
    /** `owner/repo`; '' when neither the transcript nor `gh` said. */
    repository: string;
    number: number;
    /** Null until `gh` has answered, and always without `gh`. */
    status: LinkedPrStatus | null;
}

/** An issue the conversation mentioned that none of the session's PRs closes. */
export interface LinkedIssue {
    kind: 'issue';
    /** `issue:owner/repo#12`. */
    key: string;
    /** GitHub's title once `gh` has said, else `owner/repo#12`. */
    title: string;
    url: string;
    repository: string;
    number: number;
    /** Null until `gh` has answered, and always without `gh`. */
    status: 'open' | 'closed' | null;
}

/** A claude.ai artifact the session published, or linked in a reply. */
export interface LinkedArtifact {
    kind: 'artifact';
    /** `artifact:<id>`. */
    key: string;
    /** The title its Artifact call gave it, else its id. */
    title: string;
    url: string;
    id: string;
    status: null;
}

/** A page the session showed with `show_page`. */
export interface LinkedPage {
    kind: 'page';
    /** `page:<id>`. */
    key: string;
    title: string;
    /** The `show_page` call's tool-use id. */
    id: string;
    /** When it was shown, epoch ms; null when the transcript did not say. */
    shownAt: number | null;
    status: null;
}

/** The Bugsnag error a Fix session (#414) works on. */
export interface LinkedBug {
    kind: 'bug';
    /** `bug:<url>`. */
    key: string;
    /** The error's class and message. */
    title: string;
    /** The error on the Bugsnag dashboard. */
    url: string;
    /** The Bugsnag project's name. */
    project: string;
    status: null;
}

/** The BlaakTasks task the session is linked to. */
export interface LinkedTask {
    kind: 'task';
    /** `task:<id>`. */
    key: string;
    /** The task's title once BlaakTasks has answered, else `Task`. */
    title: string;
    /** The task's id, as `window.api.getTask` takes it. */
    id: string;
    /** Its Notion page, once BlaakTasks has answered; null before. */
    url: string | null;
    /** Null until BlaakTasks has answered. */
    status: TaskStatus | null;
}

export type SessionLink = LinkedPr | LinkedIssue | LinkedArtifact | LinkedPage | LinkedBug | LinkedTask;

/** What a bug link is made of: the error, where it is on Bugsnag, and its project's name. */
export interface BugLinkFacts {
    title: string;
    url: string;
    project: string;
}

/** What a task link is made of: its id, and what BlaakTasks said about it once it has. */
export interface TaskFacts {
    id: string;
    detail: {title: string; url: string; status: TaskStatus} | null;
}

/** Everything {@link sessionLinks} works from; each list chronological, as its source has it. */
export interface SessionLinkFacts {
    /** `owner/repo` of the session's repository; '' when unknown. */
    repository: string;
    /** From the transcript's `pr-link` lines. */
    pullRequests: readonly SessionPullRequest[];
    /** What `gh` said about them, any order; null when it has not, or cannot. */
    pullRequestStatuses: readonly PullRequestStatus[] | null;
    /** From `issueMentionsInTranscript`. */
    issueMentions: readonly IssueRef[];
    /** What `gh` said about the mentions, per repository (null where it failed); null when it has not, or cannot. */
    issueStatuses: ReadonlyMap<string, IssueStatus[] | null> | null;
    artifacts: readonly ArtifactRef[];
    pages: readonly ShownPageRef[];
    /** The Bugsnag error, for a Fix session whose error's dashboard URL is known; absent otherwise. */
    bug?: BugLinkFacts | null;
    task: TaskFacts | null;
}

/** The session's links: PRs, issues, artifacts, pages, its bug, then its task; each kind newest first. */
export function sessionLinks(facts: SessionLinkFacts): SessionLink[] {
    const {repository} = facts;
    const items = deriveWorkItems({
        locations: [],
        pullRequests: facts.pullRequests,
        branches: [],
        changes: [],
        github: facts.pullRequestStatuses,
        // Only what `gh` says is an issue: a conversation's `#123` is as often
        // another PR, a list item or a number from a pasted log, and until `gh`
        // has said (or where it cannot) there is no telling which.
        issueMentions: facts.issueStatuses
            ? confirmedIssues(facts.issueMentions, facts.issueStatuses, repository).filter((issue) => 'state' in issue)
            : [],
        repository,
    });

    const linkOrder = firstIndex(facts.pullRequests.map((pr) => pr.url));
    const prs: LinkedPr[] = [];
    for (const item of items) if (item.kind === 'pr') prs.push(linkedPr(item.pr));
    prs.sort((a, b) => (linkOrder.get(b.url) ?? 0) - (linkOrder.get(a.url) ?? 0));

    const mentionOrder = firstIndex(facts.issueMentions.map((issue) => issueKey(issue, repository)));
    const issues: LinkedIssue[] = [];
    for (const item of items) {
        if (item.kind !== 'issue') continue;
        const linked = linkedIssue(item.issue, repository);
        if (linked) issues.push(linked);
    }
    issues.sort((a, b) => (mentionOrder.get(b.key) ?? 0) - (mentionOrder.get(a.key) ?? 0));

    const artifacts: LinkedArtifact[] = facts.artifacts
        .map((artifact) => ({
            kind: 'artifact' as const,
            key: 'artifact:' + artifact.id,
            title: artifact.title ?? artifact.id,
            url: artifact.url,
            id: artifact.id,
            status: null,
        }))
        .reverse();

    const pages: LinkedPage[] = facts.pages
        .map((page) => ({
            kind: 'page' as const,
            key: 'page:' + page.id,
            title: page.title,
            id: page.id,
            shownAt: page.shownAt,
            status: null,
        }))
        .reverse();

    const bug: LinkedBug[] = facts.bug ? [{kind: 'bug', key: 'bug:' + facts.bug.url, ...facts.bug, status: null}] : [];

    const task: LinkedTask[] = facts.task
        ? [
              {
                  kind: 'task',
                  key: 'task:' + facts.task.id,
                  title: facts.task.detail?.title || 'Task',
                  id: facts.task.id,
                  url: facts.task.detail?.url ?? null,
                  status: facts.task.detail?.status ?? null,
              },
          ]
        : [];

    return [...prs, ...issues, ...artifacts, ...pages, ...bug, ...task];
}

function linkedPr(pr: PullRequestStatus): LinkedPr {
    return {
        kind: 'pr',
        key: 'pr:' + pr.url,
        title: pr.title || pullRequestLabel(pr),
        url: pr.url,
        repository: pr.repository,
        number: pr.number,
        status: pr.state ? {state: pr.state, checks: checksOf(pr), dot: statusDot(pr), mine: pr.mine ?? true} : null,
    };
}

/** An issue as a link, or null when its repository is not known (there is nowhere to open it). */
function linkedIssue(issue: IssueRef | IssueStatus, repository: string): LinkedIssue | null {
    const repo = issue.repository || repository;
    if (!repo) return null;
    const status = 'state' in issue ? issue : null;
    return {
        kind: 'issue',
        key: issueKey(issue, repository),
        title: status?.title || repo + '#' + issue.number,
        url: status?.url || `https://github.com/${repo}/issues/${issue.number}`,
        repository: repo,
        number: issue.number,
        status: status?.state ?? null,
    };
}

function issueKey(issue: IssueRef, repository: string): string {
    return 'issue:' + (issue.repository || repository) + '#' + issue.number;
}

function checksOf(pr: PullRequestStatus): LinkedPrStatus['checks'] {
    const checks = pr.checks ?? [];
    if (checks.some((check) => check.state === 'failing')) return 'failing';
    if (checks.some((check) => check.state === 'pending')) return 'pending';
    if (checks.some((check) => check.state === 'passing')) return 'passing';
    return 'none';
}

/** Each value's first position. */
function firstIndex(values: readonly string[]): Map<string, number> {
    const order = new Map<string, number>();
    values.forEach((value, index) => {
        if (!order.has(value)) order.set(value, index);
    });
    return order;
}
