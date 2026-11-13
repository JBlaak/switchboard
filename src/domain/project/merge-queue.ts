/**
 * The merge queue on a project page (#315): what a repository's serial merge
 * queue says about its open pull requests, turned into the queue as the page
 * shows it.
 *
 * Switchboard never works the queue out itself. The queue is a GitHub Action
 * that writes everything it decides onto the PRs: its labels, and an
 * `automerge` commit status whose one-line description says where the PR
 * stands ("Number 3 in the merge queue", "Waits for a review by @x"). This
 * reads those back. A status it does not recognise keeps its raw text, so a
 * new one from the queue shows as written instead of breaking the section.
 *
 * Estimates come from the repository's recent green CI runs: the median is one
 * run. The head needs what is left of its run, and every entry behind it one
 * more run per PR in it (a stack's CI runs member after member) and one queue
 * step (the rebase and push before CI, the merge after it). A held entry adds
 * nothing, since the queue passes over it. An estimate is good near the head
 * and rough further back, so from place 3 on it is rounded to 5 minutes and
 * shown faded (`expectedMinutes`).
 *
 * A queue with failed entries, no head and nothing the next pass would pick
 * (held entries are passed over) is stalled: nothing in it moves until
 * someone acts on a failed one.
 */
import type {ReviewDecision} from './overview';

/** The labels the queue reads and writes. Only `optIn` and removing `failed` are ever written by Switchboard. */
export const QUEUE_LABELS = {
    optIn: 'automerge:opt-in',
    next: 'automerge:next',
    failed: 'automerge:failed',
    head: 'bot: first in queue',
    withStack: 'bot: merges with stack',
    rebaseOptIn: 'autorebase:opt-in',
    nonRebaseable: 'autorebase:non-rebaseable',
} as const;

/** The commit status context the queue sets on every labelled PR. */
export const AUTOMERGE_CONTEXT = 'automerge';

/** How many green runs it takes before an estimate is worth showing. */
export const MIN_RUNS_FOR_ESTIMATE = 3;

/** The shortest estimate shown, so a run that overstays its median never says "0 min". */
export const MIN_ESTIMATE_MS = 60_000;

/**
 * A queue step: the queue's rebase and push before an entry's CI, and its
 * merge after it, about a minute together. Every entry costs one CI run per
 * PR in it and one step; the head, whose rebase is behind it, half of one.
 */
export const QUEUE_STEP_MS = 60_000;

/** From this place on an estimate is rough: rounded to 5 minutes and shown faded. */
export const ROUGH_FROM_PLACE = 3;

// ── What is read ──

/** One check run on a PR's head commit. */
export interface QueueCheckRun {
    name: string;
    state: 'queued' | 'running' | 'passed' | 'failed' | 'cancelled' | 'skipped';
    /** Epoch ms it started; null while queued or when GitHub did not say. */
    startedAt: number | null;
}

/** The queue's `automerge` status on a PR's head commit. */
export interface AutomergeStatus {
    state: 'pending' | 'success' | 'failure' | 'error';
    description: string;
}

/** An open pull request, with what the queue wrote on it. */
export interface QueuePullRequest {
    number: number;
    title: string;
    url: string;
    headRef: string;
    baseRef: string;
    draft: boolean;
    labels: readonly string[];
    /** Null when the queue has written none (yet). */
    automerge: AutomergeStatus | null;
    review: ReviewDecision;
    /** Logins a review is still requested from. */
    requestedReviewers: readonly string[];
    /** Logins that approved it. */
    approvedBy: readonly string[];
    checks: readonly QueueCheckRun[];
}

export interface MergeQueueInput {
    /** The branch the queue merges into. */
    trunk: string;
    pullRequests: readonly QueuePullRequest[];
    /** How long the repository's recent green CI runs took, ms, any order. */
    ciRunDurationsMs: readonly number[];
    /** Epoch ms. */
    now: number;
}

// ── What a status says ──

export type ParsedStatus =
    | {kind: 'head'; waitsForCiOn: number | null}
    | {kind: 'queued'; position: number}
    | {kind: 'held'; waitsFor: HeldReason}
    | {kind: 'outside'; why: OutsideReason}
    | {kind: 'failed'; reason: string}
    | {kind: 'unknown'; text: string};

/**
 * Whom a held entry waits for. A review can be asked of a team (`@org/team`):
 * `team` is then true and `reviewer` is the team's `org/slug`, which no one can
 * be nudged as.
 */
export type HeldReason = {kind: 'approval'} | {kind: 'review'; reviewer: string; team: boolean};

export type OutsideReason =
    {kind: 'draft'} | {kind: 'base'; base: string} | {kind: 'stack-draft'; member: number} | {kind: 'not-opted-in'};

/** A status about one member of a stack, as the other members show it (`#N: …`). */
export interface StatusOf {
    /** The member it is about; null when it is about the PR itself. */
    member: number | null;
    status: ParsedStatus;
}

/** What the `automerge` status says, in the queue's words (merge-queue README, "Labels"). */
export function parseAutomergeStatus(status: AutomergeStatus): StatusOf {
    const prefixed = /^#(\d+):\s*(.*)$/s.exec(status.description.trim());
    if (prefixed) {
        return {member: Number(prefixed[1]), status: parseText(status.state, prefixed[2].trim())};
    }
    return {member: null, status: parseText(status.state, status.description.trim())};
}

function parseText(state: AutomergeStatus['state'], text: string): ParsedStatus {
    if (state === 'failure' || state === 'error') return {kind: 'failed', reason: text};
    let match: RegExpExecArray | null;
    if ((match = /^First in the merge queue; waits for CI on #(\d+)/i.exec(text))) {
        return {kind: 'head', waitsForCiOn: Number(match[1])};
    }
    if (/^First in the merge queue/i.test(text)) return {kind: 'head', waitsForCiOn: null};
    if ((match = /^Number (\d+) in the merge queue/i.exec(text))) return {kind: 'queued', position: Number(match[1])};
    if (/^Waits for an approval/i.test(text)) return {kind: 'held', waitsFor: {kind: 'approval'}};
    if ((match = /^Waits for a review by @([\w-]+(?:\/[\w.-]+)?)/i.exec(text))) {
        return {kind: 'held', waitsFor: {kind: 'review', reviewer: match[1], team: match[1].includes('/')}};
    }
    if (/^A draft is not queued/i.test(text)) return {kind: 'outside', why: {kind: 'draft'}};
    if ((match = /^Waits until #(\d+) is ready for review/i.exec(text))) {
        return {kind: 'outside', why: {kind: 'stack-draft', member: Number(match[1])}};
    }
    if ((match = /^Waits until `?([^`]+?)`? merges/i.exec(text))) {
        return {kind: 'outside', why: {kind: 'base', base: match[1]}};
    }
    return {kind: 'unknown', text};
}

// ── The queue as the page shows it ──

/** A PR inside an entry: the entry's own PR, or a member of its stack. */
export interface EntryMember {
    number: number;
    title: string;
    url: string;
    headRef: string;
    approved: boolean;
    /** The PR carrying the queue label: the stack's top, or the single PR. */
    labelled: boolean;
}

/** One place in the queue: a PR, or a GitHub stack up to its labelled PR. */
export interface QueueEntry {
    /** The labelled PR's number: the one the queue's status is about. */
    number: number;
    title: string;
    url: string;
    headRef: string;
    /** Bottom-up; one member for a single PR. */
    members: EntryMember[];
    stack: boolean;
    /** Labelled `automerge:next`: ahead of every entry without it. */
    next: boolean;
    approvedBy: readonly string[];
}

/**
 * Where the head is. `checks` counts every check run on its members, optional
 * ones included: `done` are the finished ones, whatever they finished as. Once
 * none is running or queued it is `merging`, since a failed optional check
 * holds nothing up (a failed required one fails the entry instead).
 */
export type HeadStage =
    | {kind: 'rebasing'}
    | {kind: 'checks'; done: number; total: number; running: string | null; waitsForCiOn: number | null}
    | {kind: 'merging'};

export interface QueueHead extends QueueEntry {
    stage: HeadStage;
    /** Epoch ms its current CI run started; null when none is running. */
    runningSince: number | null;
    /** Ms until it merges; null without estimates. */
    estimateMs: number | null;
}

export interface QueuedEntry extends QueueEntry {
    /** 2 and up, as shown: the queue's own number, then the held entries after them. */
    position: number;
    /**
     * A held entry's `member` is the stack member it waits on (the queue's
     * `#N: …`); null when it is the labelled PR itself.
     */
    state: {kind: 'queued'} | {kind: 'held'; waitsFor: HeldReason; member: number | null};
    /** One sentence on why it is where it is. */
    sentence: string;
    /** Ms until it merges; null when held, or without estimates. */
    estimateMs: number | null;
}

export type FailureKind = 'ci' | 'conflict' | 'changes-requested' | 'unresolved-thread' | 'merge-refused' | 'other';

export interface FailedEntry extends QueueEntry {
    kind: FailureKind;
    /** The queue's own words. */
    reason: string;
    /** The member it failed on, in a stack; null for the entry's own PR. */
    failedMember: number | null;
    /** The first failed check run's name, for a CI failure. */
    failingCheck: string | null;
    /** What puts it back, in a sentence. */
    rejoins: string;
}

export interface OutsideEntry {
    number: number;
    title: string;
    url: string;
    why: OutsideReason;
    /** The chip's text: "#2270 draft". */
    text: string;
}

/** A PR whose `automerge` status this module does not know: shown with its raw text. */
export interface UnknownEntry {
    number: number;
    title: string;
    url: string;
    text: string;
}

/** The short pill a PR gets on its Pull requests row and its session's sidebar row. */
export interface QueuePill {
    kind: 'merging' | 'queued' | 'held' | 'failed' | 'queueable' | 'kept-rebased' | 'rebase-conflict';
    text: string;
    /** The full sentence, for a tooltip. */
    title: string;
}

export interface MergeQueue {
    head: QueueHead | null;
    /** Behind the head, in order: the queue's numbered entries, then the held ones. */
    entries: QueuedEntry[];
    failed: FailedEntry[];
    outside: OutsideEntry[];
    unknown: UnknownEntry[];
    counts: {queued: number; held: number; failed: number};
    /**
     * Failed entries, no head, and nothing queued that the next pass would
     * pick (held entries are passed over): nothing moves until a failed one
     * is acted on.
     */
    stalled: boolean;
    /** Ms until every queued entry has merged; null without estimates or with nothing queued. */
    clearsInMs: number | null;
    /** The place of the entry `clearsInMs` is about (1 for the head alone); null with it. */
    clearsAtPlace: number | null;
    /** One CI run, the median of the green ones; null with fewer than MIN_RUNS_FOR_ESTIMATE. */
    runMs: number | null;
    /** Pills by PR number. */
    pills: Record<number, QueuePill>;
}

/** An expected merge time as shown: whole minutes, and whether it is rough (rounded to 5, faded). */
export interface ExpectedMinutes {
    minutes: number;
    rough: boolean;
}

/**
 * How `ms` reads at `place` (the head is 1): to the minute near the head, and
 * from place 3 on, where the guess is rough, to 5 minutes. Never under one
 * minute, or under five once rough.
 */
export function expectedMinutes(ms: number, place: number): ExpectedMinutes {
    const minutes = ms / 60_000;
    if (place >= ROUGH_FROM_PLACE) return {minutes: Math.max(5, Math.round(minutes / 5) * 5), rough: true};
    return {minutes: Math.max(1, Math.round(minutes)), rough: false};
}

/** Whether a repository uses the queue: one of its open PRs carries a queue label or status. */
export function usesMergeQueue(pullRequests: readonly QueuePullRequest[]): boolean {
    const labels: readonly string[] = Object.values(QUEUE_LABELS);
    return pullRequests.some((pr) => pr.automerge !== null || pr.labels.some((label) => labels.includes(label)));
}

/** The median of the green runs, or null with too few to go by. */
export function medianRunMs(durations: readonly number[]): number | null {
    const sorted = durations.filter((ms) => Number.isFinite(ms) && ms > 0).sort((a, b) => a - b);
    if (sorted.length < MIN_RUNS_FOR_ESTIMATE) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/** The queue as the page shows it. */
export function mergeQueue(input: MergeQueueInput): MergeQueue {
    const prs = input.pullRequests;
    const byNumber = new Map(prs.map((pr) => [pr.number, pr]));
    const byHead = new Map(prs.map((pr) => [pr.headRef, pr]));
    const runMs = medianRunMs(input.ciRunDurationsMs);

    // A stack member labelled `bot: merges with stack` shows only inside its stack's entry.
    const inStack = new Set<number>();
    const membersOf = (top: QueuePullRequest): QueuePullRequest[] => {
        const chain: QueuePullRequest[] = [top];
        let current = top;
        const seen = new Set([top.number]);
        while (current.baseRef !== input.trunk) {
            const below = byHead.get(current.baseRef);
            if (!below || seen.has(below.number)) break;
            seen.add(below.number);
            chain.push(below);
            current = below;
        }
        return chain.reverse();
    };

    const entryOf = (pr: QueuePullRequest): QueueEntry => {
        const isQueued = hasLabel(pr, QUEUE_LABELS.optIn) || hasLabel(pr, QUEUE_LABELS.next);
        const chain = isQueued ? membersOf(pr) : [pr];
        const stack = chain.length > 1;
        if (stack) for (const member of chain.slice(0, -1)) inStack.add(member.number);
        return {
            number: pr.number,
            title: pr.title,
            url: pr.url,
            headRef: pr.headRef,
            members: chain.map((member) => ({
                number: member.number,
                title: member.title,
                url: member.url,
                headRef: member.headRef,
                approved: member.review === 'approved' || member.approvedBy.length > 0,
                labelled: member.number === pr.number,
            })),
            stack,
            next: hasLabel(pr, QUEUE_LABELS.next),
            approvedBy: pr.approvedBy,
        };
    };

    // The labelled PRs first, so their stacks claim their members before the members are looked at.
    const labelled = prs.filter(
        (pr) =>
            (hasLabel(pr, QUEUE_LABELS.optIn) ||
                hasLabel(pr, QUEUE_LABELS.next) ||
                hasLabel(pr, QUEUE_LABELS.failed)) &&
            !hasLabel(pr, QUEUE_LABELS.withStack),
    );

    let head: QueueHead | null = null;
    const queued: {entry: QueueEntry; position: number}[] = [];
    const held: {entry: QueueEntry; waitsFor: HeldReason; member: number | null}[] = [];
    const failed: FailedEntry[] = [];
    const outside: OutsideEntry[] = [];
    const unknown: UnknownEntry[] = [];
    const placed = new Set<number>();

    for (const pr of labelled) {
        const entry = entryOf(pr);
        placed.add(pr.number);
        const parsed = pr.automerge ? parseAutomergeStatus(pr.automerge) : null;
        const status = parsed?.status ?? null;
        if (hasLabel(pr, QUEUE_LABELS.failed) || status?.kind === 'failed') {
            const reason = status?.kind === 'failed' ? status.reason : 'Failed in the merge queue';
            failed.push(failedEntry(entry, reason, parsed?.member ?? null, byNumber));
            continue;
        }
        if (!status) {
            // Labelled, but no pass has written its status yet: it waits in the queue's order.
            held.push({entry, waitsFor: {kind: 'approval'}, member: null});
            continue;
        }
        switch (status.kind) {
            case 'head':
                head = headOf(entry, status.waitsForCiOn, byNumber, input.now, runMs);
                break;
            case 'queued':
                queued.push({entry, position: status.position});
                break;
            case 'held':
                held.push({entry, waitsFor: status.waitsFor, member: parsed?.member ?? null});
                break;
            case 'outside':
                outside.push(outsideEntry(pr, status.why));
                break;
            case 'unknown':
                unknown.push({number: pr.number, title: pr.title, url: pr.url, text: status.text});
                break;
        }
    }

    // Open PRs the queue has not taken: drafts and approved ones nobody opted in.
    for (const pr of prs) {
        if (placed.has(pr.number) || inStack.has(pr.number) || hasLabel(pr, QUEUE_LABELS.withStack)) continue;
        if (pr.automerge) {
            const status = parseAutomergeStatus(pr.automerge).status;
            if (status.kind === 'outside') {
                outside.push(outsideEntry(pr, status.why));
                continue;
            }
        }
        if (!pr.draft && pr.review === 'approved') outside.push(outsideEntry(pr, {kind: 'not-opted-in'}));
    }

    queued.sort((a, b) => a.position - b.position);
    let elapsed = head?.estimateMs ?? (head ? null : 0);
    const entries: QueuedEntry[] = [];
    let position = 2;
    for (const {entry} of queued) {
        if (elapsed !== null && runMs !== null) elapsed += runMs * entry.members.length + QUEUE_STEP_MS;
        else elapsed = null;
        entries.push({
            ...entry,
            position: position++,
            state: {kind: 'queued'},
            sentence: queuedSentence(entry),
            estimateMs: runMs === null ? null : elapsed,
        });
    }
    for (const {entry, waitsFor, member} of held.sort((a, b) => a.entry.number - b.entry.number)) {
        entries.push({
            ...entry,
            position: position++,
            state: {kind: 'held', waitsFor, member},
            sentence: heldSentence(waitsFor, member),
            estimateMs: null,
        });
    }

    const lastQueued = [...entries].reverse().find((entry) => entry.state.kind === 'queued');
    const clearsInMs = runMs === null ? null : (lastQueued?.estimateMs ?? head?.estimateMs ?? null);
    const clearsAtPlace = clearsInMs === null ? null : (lastQueued?.position ?? 1);

    return {
        head,
        entries,
        failed,
        outside,
        unknown,
        counts: {
            queued: (head ? 1 : 0) + entries.filter((entry) => entry.state.kind === 'queued').length,
            held: entries.filter((entry) => entry.state.kind === 'held').length,
            failed: failed.length,
        },
        stalled: head === null && !lastQueued && failed.length > 0,
        clearsInMs,
        clearsAtPlace,
        runMs,
        pills: pillsOf(prs, input.trunk, head, entries, failed, outside),
    };
}

// ── The head ──

function headOf(
    entry: QueueEntry,
    waitsForCiOn: number | null,
    byNumber: Map<number, QueuePullRequest>,
    now: number,
    runMs: number | null,
): QueueHead {
    const checks = entry.members.flatMap((member) => byNumber.get(member.number)?.checks ?? []);
    const done = checks.filter((check) => check.state !== 'running' && check.state !== 'queued').length;
    const running = checks.find((check) => check.state === 'running') ?? null;
    const starts = checks
        .filter((check) => check.state === 'running' || check.state === 'queued')
        .map((check) => check.startedAt)
        .filter((at): at is number => at !== null);
    const runningSince = starts.length ? Math.min(...starts) : null;

    let stage: HeadStage;
    if (checks.length === 0) stage = {kind: 'rebasing'};
    else if (done === checks.length)
        stage = {kind: 'merging'}; // none running or queued
    else stage = {kind: 'checks', done, total: checks.length, running: running?.name ?? null, waitsForCiOn};

    // What is left of its CI, then half a queue step for the merge; a whole run and step before its CI starts.
    let estimateMs: number | null = null;
    if (runMs !== null) {
        if (stage.kind === 'merging') estimateMs = MIN_ESTIMATE_MS;
        else if (runningSince !== null) {
            estimateMs = Math.max(MIN_ESTIMATE_MS, Math.max(0, runMs - (now - runningSince)) + QUEUE_STEP_MS / 2);
        } else estimateMs = runMs + QUEUE_STEP_MS;
        // A stack's members above the one running still need a run each.
        if (entry.stack && waitsForCiOn !== null) {
            const index = entry.members.findIndex((member) => member.number === waitsForCiOn);
            if (index >= 0) estimateMs += runMs * (entry.members.length - 1 - index);
        }
    }
    return {...entry, stage, runningSince, estimateMs};
}

// ── Failures ──

function failedEntry(
    entry: QueueEntry,
    reason: string,
    member: number | null,
    byNumber: Map<number, QueuePullRequest>,
): FailedEntry {
    const kind = failureKind(reason);
    const looked = member !== null ? byNumber.get(member) : byNumber.get(entry.number);
    const failingCheck =
        kind === 'ci' ? (looked?.checks.find((check) => check.state === 'failed')?.name ?? null) : null;
    return {...entry, kind, reason, failedMember: member, failingCheck, rejoins: rejoinsSentence(kind)};
}

/** What kind of failure the queue's reason describes. */
export function failureKind(reason: string): FailureKind {
    if (/conflict/i.test(reason)) return 'conflict';
    if (/changes? requested|requests? changes/i.test(reason)) return 'changes-requested';
    if (/thread/i.test(reason)) return 'unresolved-thread';
    // Whole words only: "insufficient", "decision" and "latest" are not about CI.
    if (/\bCI\b|\bchecks?\b|\btests?\b|\bcancel(l?ed)?\b|\btimed? ?out\b/i.test(reason)) return 'ci';
    if (/refus|merge/i.test(reason)) return 'merge-refused';
    return 'other';
}

function rejoinsSentence(kind: FailureKind): string {
    return kind === 'ci'
        ? 'Rejoins at its place on a new commit, a green re-run, or Retry'
        : 'Rejoins at its place on a new commit, or Retry';
}

// ── Sentences ──

function queuedSentence(entry: QueueEntry): string {
    if (entry.stack) {
        return `CI runs bottom-up as the head: #${entry.members[0].number} first, the rest once the one below is green`;
    }
    return 'Approved · its CI is paused until it is the head, so it costs no run now';
}

function heldSentence(waitsFor: HeldReason, member: number | null): string {
    const on = member === null ? '' : ` #${member}`;
    return waitsFor.kind === 'review'
        ? `Held — keeps its place, passed over until @${waitsFor.reviewer} reviews${on}`
        : `Held — keeps its place, passed over until${on || ' it'} is approved`;
}

function outsideEntry(pr: QueuePullRequest, why: OutsideReason): OutsideEntry {
    let text: string;
    switch (why.kind) {
        case 'draft':
            text = `#${pr.number} draft`;
            break;
        case 'base':
            text = `#${pr.number} waits until ${why.base} merges`;
            break;
        case 'stack-draft':
            text = `#${pr.number} waits until #${why.member} is ready`;
            break;
        case 'not-opted-in':
            text = `#${pr.number} approved, not queued`;
            break;
    }
    return {number: pr.number, title: pr.title, url: pr.url, why, text};
}

// ── Pills ──

function ordinal(n: number): string {
    const tens = n % 100;
    if (tens >= 11 && tens <= 13) return `${n}th`;
    return `${n}${n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'}`;
}

function pillsOf(
    prs: readonly QueuePullRequest[],
    trunk: string,
    head: QueueHead | null,
    entries: readonly QueuedEntry[],
    failed: readonly FailedEntry[],
    outside: readonly OutsideEntry[],
): Record<number, QueuePill> {
    const pills: Record<number, QueuePill> = {};
    const all = (entry: QueueEntry, pill: QueuePill): void => {
        for (const member of entry.members) pills[member.number] = pill;
    };
    for (const pr of prs) {
        if (hasLabel(pr, QUEUE_LABELS.nonRebaseable)) {
            pills[pr.number] = {
                kind: 'rebase-conflict',
                text: `conflicts with ${trunk}`,
                title: 'The last rebase conflicted',
            };
        } else if (hasLabel(pr, QUEUE_LABELS.rebaseOptIn)) {
            pills[pr.number] = {
                kind: 'kept-rebased',
                text: 'kept rebased',
                title: 'Kept rebased on the trunk, never merged',
            };
        }
    }
    for (const entry of outside) {
        if (entry.why.kind === 'not-opted-in') {
            pills[entry.number] = {kind: 'queueable', text: '+ Queue', title: 'Approved, not in the merge queue'};
        }
    }
    if (head) all(head, {kind: 'merging', text: 'merging · 1st', title: 'First in the merge queue'});
    for (const entry of entries) {
        all(
            entry,
            entry.state.kind === 'held'
                ? {kind: 'held', text: 'held', title: entry.sentence}
                : {kind: 'queued', text: `queued · ${ordinal(entry.position)}`, title: entry.sentence},
        );
    }
    for (const entry of failed) all(entry, {kind: 'failed', text: 'queue failed', title: entry.reason});
    return pills;
}

function hasLabel(pr: QueuePullRequest, label: string): boolean {
    return pr.labels.some((name) => name.toLowerCase() === label.toLowerCase());
}
