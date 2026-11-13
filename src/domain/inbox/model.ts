/**
 * The managers' inbox (#413, for #409): what an item is, the state it is in,
 * and what each poll last read of it.
 *
 * An item is a Bugsnag error (the Bug manager's) or a loose GitHub issue (the
 * Issue manager's). Its state is Switchboard's own, never written back:
 *
 * - `unread`: new to look at. The only state the managers count.
 * - `read`: seen, left in the inbox.
 * - `snoozed`: put away until a time, or until it changes (`until` null).
 * - `backlog`: put away until it changes in a way the inbox cares about.
 * - `inProgress`: a Fix or Start session works on it, at a stage.
 * - `done`: merged or fixed; kept for seven days, then dropped.
 *
 * What a poll read is the item's `facts`; what the inbox worked out from them
 * (its signals, for a bug) sits beside them, so the next poll can tell what
 * changed. Times are epoch ms; the facts keep GitHub's and Bugsnag's ISO times
 * as they came.
 */
import type {IssueLabel} from '../project/overview';

export type InboxManager = 'bug' | 'issue';

/** Where an in-progress item stands, as its row's pill shows it (#414, #415). */
export type InboxStage = 'working' | 'needsYou' | 'prCi' | 'ciFailing' | 'ready' | 'queue' | 'merged';

export type InboxState =
    | {readonly kind: 'unread'}
    | {readonly kind: 'read'}
    /** `until` null: until it changes. */
    | {readonly kind: 'snoozed'; readonly until: number | null}
    | {readonly kind: 'backlog'}
    | {readonly kind: 'inProgress'; readonly stage: InboxStage}
    | {readonly kind: 'done'; readonly at: number};

/** A Bugsnag error as the last poll read it. */
export interface BugFacts {
    readonly kind: 'bug';
    readonly projectId: string;
    readonly errorId: string;
    readonly errorClass: string;
    readonly message: string;
    readonly context: string;
    readonly severity: string;
    /** `open`, `fixed`, `ignored`, … as Bugsnag says. */
    readonly status: string;
    readonly releaseStages: readonly string[];
    /** ISO: first seen at all, unfiltered. */
    readonly firstSeen: string;
    /** ISO. */
    readonly lastSeen: string;
    /** Events and users over the error's whole life. */
    readonly events: number;
    readonly users: number;
    /** Events in the last 24 hours and the last 7 days, the trend's two numbers. */
    readonly events24h: number;
    readonly events7d: number;
    readonly linkedIssues: readonly string[];
}

/** A loose GitHub issue as the last poll read it. */
export interface IssueFacts {
    readonly kind: 'issue';
    /** `owner/repo`. */
    readonly repository: string;
    readonly number: number;
    readonly title: string;
    readonly url: string;
    /** Login; null for a deleted account. */
    readonly author: string | null;
    readonly assignees: readonly string[];
    readonly labels: readonly IssueLabel[];
    /** ISO. */
    readonly createdAt: string;
    readonly updatedAt: string;
    /** How many comments it has. */
    readonly comments: number;
    /** Who wrote the newest comment; null without one. */
    readonly lastCommentBy: string | null;
    /** How many times a commit referenced it. */
    readonly references: number;
}

export type InboxFacts = BugFacts | IssueFacts;

/** What the Bug manager worked out about a bug (#409 story 7). */
export interface BugSignals {
    /** First seen since its project was first synced: open, in production, severity error. */
    readonly new: boolean;
    /** Its last 24 hours stand out against its 7-day daily average. */
    readonly trending: boolean;
    /** Seen again after its fix shipped, as the Bug manager page judges it (#414). */
    readonly regressed: boolean;
}

/** A PR a Fix or Start session opened, as far as the managers' pages show it. */
export interface WorkPullRequestRef {
    readonly number: number;
    readonly url: string;
}

/**
 * A bug's Fix (#414): where its session runs, the branch it works on and
 * what came of it. Kept after the work ends, for Done's merge, the seen-again
 * judgement and the "Tried, no PR" mark.
 */
export interface BugFix {
    /** The local project the session works in. */
    readonly projectPath: string;
    /** `owner/repo` of that project; the branch's PR is looked up there. */
    readonly repository: string;
    readonly branch: string;
    /** The worktree the session runs in. */
    readonly worktree: string;
    /** The session's id; null until it is known. */
    readonly sessionId: string | null;
    readonly startedAt: number;
    /** The branch's PR, once opened. */
    readonly pr: WorkPullRequestRef | null;
    /** Its place in the merge queue, from 1, while it is queued. */
    readonly queuePosition: number | null;
    /** Its checks: how many passed, of how many, and the failing ones' names. */
    readonly checks: {readonly passed: number; readonly total: number; readonly failing: readonly string[]} | null;
    /** The session ended (it exited); it may have opened a PR before. */
    readonly sessionEnded: boolean;
    /** How the work ended without a merge: a session that left no PR, or Stop working on it. */
    readonly ended: 'noPr' | 'stopped' | null;
    /** When the PR merged, and its merge commit. */
    readonly mergedAt: number | null;
    readonly mergeCommit: string | null;
    /** Bugsnag was told the error is fixed (a bug's merge), so it is told only once. */
    readonly markedFixed: boolean;
    /** Events before this time are settled: the merge, or the last Close again. */
    readonly quietSince: number | null;
    /** The events after the merge that asked you, while they wait for an answer. */
    readonly seenAgain: SeenAgainNotice | null;
    /** What happened, in order, for the detail's timeline. */
    readonly timeline: readonly WorkStep[];
}

/** One step of the work's timeline. */
export interface WorkStep {
    readonly at: number;
    readonly text: string;
}

/** Events after a merge that came from a release without the fix (or could not be told). */
export interface SeenAgainNotice {
    readonly events: number;
    readonly version: string | null;
    readonly tag: string | null;
    readonly tagged: boolean;
}

export interface InboxItem {
    /** `bug:<projectId>:<errorId>` or `issue:<owner/repo>#<n>`; see `inboxKey`. */
    readonly key: string;
    readonly manager: InboxManager;
    /** The Bugsnag project id or the `owner/repo` it was read from. */
    readonly source: string;
    /** When Switchboard first listed it. */
    readonly createdAt: number;
    readonly state: InboxState;
    readonly facts: InboxFacts;
    /** A bug's signals; null for an issue. */
    readonly signals: BugSignals | null;
    /** Your notes on it, put in a Start session's prompt (#415). Kept across snooze and backlog. */
    readonly notes: string;
    /**
     * An issue's comment count when it was last seen (#415): an unread issue
     * with more has new comments; one never seen is new. Absent until seen.
     */
    readonly seenComments?: number;
    /** The Fix or Start session's work on it (#414, #415), while in progress and once done. */
    readonly work?: InboxWork | null;
    /** A bug's Fix as the Bug manager page follows it (#414); absent before any. Kept after the work ends. */
    readonly fix?: BugFix | null;
}

/** What a Fix or Start session works on: its branch, the session, and the PR it opened. */
export interface InboxWork {
    readonly branch: string;
    /** The session started on it; null when not known. */
    readonly sessionId: string | null;
    /** The PR that closes it, once one is open; null before. */
    readonly pullRequest: number | null;
}

/** An item's key. */
export function inboxKey(facts: InboxFacts): string {
    return facts.kind === 'bug'
        ? `bug:${facts.projectId}:${facts.errorId}`
        : `issue:${facts.repository}#${facts.number}`;
}

/** The source an item is read from. */
export function sourceOf(facts: InboxFacts): string {
    return facts.kind === 'bug' ? facts.projectId : facts.repository;
}

export function managerOf(facts: InboxFacts): InboxManager {
    return facts.kind;
}

/** A bug that is trending or regressed: what makes the Bug manager frantic. */
export function isUrgent(item: InboxItem): boolean {
    return item.signals !== null && (item.signals.trending || item.signals.regressed);
}

/** The counts on a manager's figure: unread items, and how many of them are urgent. */
export interface ManagerCounts {
    readonly unread: number;
    readonly urgent: number;
}

/**
 * Which managers are set up (#416): the Bug manager with a saved token and
 * at least one opted-in project, the Issue manager with at least one project
 * on Watch issues. A manager only stands on the empty screen once it is.
 */
export interface ConfiguredManagers {
    readonly bug: boolean;
    readonly issue: boolean;
}

/** Both managers' counts and which of them are set up, as main pushes them to the renderer. */
export interface InboxSummary {
    readonly bug: ManagerCounts;
    readonly issue: ManagerCounts;
    readonly configured: ConfiguredManagers;
}

export const EMPTY_INBOX_SUMMARY: InboxSummary = {
    bug: {unread: 0, urgent: 0},
    issue: {unread: 0, urgent: 0},
    configured: {bug: false, issue: false},
};
