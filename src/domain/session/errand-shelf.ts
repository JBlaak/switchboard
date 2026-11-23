/**
 * Errands in the sidebar: which sessions are errands, and what each is doing,
 * as the Automatic shelf shows them.
 *
 * An errand is a session Switchboard started by itself: the Merge manager's
 * fix errands (#437) and the merge queue's Nudge and Fix (#315), each for a
 * pull request, the Bug manager's quick triage, for a bug, and a schedule's
 * run while the shelf lists it (see `domain/schedule/shelf`). A session the
 * user started is never one. Errands keep out of the
 * user's own sections and sit on a shelf docked under the session list;
 * only a stuck one (or a run that needs you) also shows in Blocked, below the
 * user's own rows.
 *
 * Pure: the caller hands in what main last pushed (the Merge manager's
 * lanes, the queue's errands, the bugs being triaged and the Schedule
 * manager's runs) and gets one index keyed by session id.
 */
import {listedRuns, runStatusText, type ShelfRun} from '../schedule/shelf';
import type {TriageErrandView} from '../inbox/model';
import type {MergeManagerState} from '../merge-manager/model';
import type {QueueErrandView} from '../project/queue-errands';
import type {ScheduleManagerFacts} from '../schedule/manager';

/**
 * What an errand does: a fix (wrench), a nudge (paper plane), a triage
 * (magnifier) or a scheduled run (hourglass).
 */
export type ErrandKind = 'fix' | 'nudge' | 'triage' | 'scheduled';

/** Who started it. */
export type ErrandOwner = 'merge-manager' | 'queue' | 'bug-manager' | 'schedule';

/**
 * One errand's session, as the shelf and a stuck row in Blocked show it. A
 * fix or a nudge works on a pull request and has its number; a triage (on a
 * bug) and a scheduled run have none.
 */
export type ErrandEntry = ErrandFields &
    (
        | {readonly kind: 'fix' | 'nudge'; readonly number: number}
        | {readonly kind: 'triage' | 'scheduled'; readonly number: null}
    );

/** What every errand says, whatever its kind. */
interface ErrandFields {
    readonly sessionId: string;
    readonly owner: ErrandOwner;
    /** `owner/repo`; a scheduled run's project path. */
    readonly repository: string;
    /**
     * The bug's title (error class and message) for a triage, the schedule's
     * name for a scheduled run; null for an errand on a pull request.
     */
    readonly title: string | null;
    /**
     * What it is doing, in a few words: "fixing checks", "rebasing", "nudging
     * the reviewer", "triaging", "stopped: asks"; for a scheduled run, its due
     * time while it runs or its outcome ("limit hit").
     */
    readonly doing: string;
    /** Stuck: it stopped without finishing, and only the user can move it on. */
    readonly needsYou: boolean;
    /** The VM's name when the Merge manager's errands run on a VM merging was handed off to; null on this Mac. */
    readonly host: string | null;
    /** The run, for a scheduled run; absent for the other kinds. */
    readonly run?: ShelfRun;
}

const OWNER_NAMES: Readonly<Record<ErrandOwner, string>> = {
    'merge-manager': 'the Merge manager',
    queue: 'the merge queue',
    'bug-manager': 'the Bug manager',
    schedule: 'the Schedule manager',
};

/**
 * What the session header says of an open errand: "Errand for the Merge
 * manager · fixing checks on #431 · archives itself", or for a triage
 * "Errand for the Bug manager · triaging TypeError: x is undefined · archives
 * itself" ("stopped triaging …" once it stopped without a verdict). A
 * scheduled run says whose run it is and how it went: "Scheduled run of
 * Bugsnag sweep · running since 03:00".
 */
export function errandHeaderText(errand: ErrandEntry): string {
    if (errand.run) return `Scheduled run of ${errand.run.name} · ${runStatusText(errand.run)}`;
    const owner = OWNER_NAMES[errand.owner];
    const what =
        errand.number === null
            ? `${errand.needsYou ? 'stopped triaging' : 'triaging'} ${shortTitle(errand.title ?? '')}`
            : `${errand.doing} on #${errand.number}`;
    return `Errand for ${owner} · ${what} · archives itself`;
}

/** The longest a bug's title runs on the shelf and in the header before it is cut. */
export const SHORT_TITLE_LENGTH = 40;

/** A bug's title cut to fit one line: at most `SHORT_TITLE_LENGTH` characters, ending in "…" when cut. */
export function shortTitle(title: string): string {
    const flat = title.replace(/\s+/g, ' ').trim();
    if (flat.length <= SHORT_TITLE_LENGTH) return flat;
    return flat.slice(0, SHORT_TITLE_LENGTH - 1).trimEnd() + '…';
}

/** The repository's short name: `owner/repo` → `repo`. */
export function shortRepository(repository: string): string {
    const slash = repository.lastIndexOf('/');
    return slash === -1 ? repository : repository.slice(slash + 1);
}

/**
 * Every errand's session, keyed by session id.
 *
 * A fix errand is the session a landed PR names as its `errand` while the PR
 * is Fixing (doing what its cause says) or Needs you because that errand
 * stopped. Once the PR has moved on (a fix was pushed, it went back to its
 * place) the errand is finishing and archives itself. A queue errand counts
 * from the moment the renderer started its session until it is done. A
 * triage counts while the Bug manager lists its bug as being triaged; one
 * that stopped without a verdict needs you. A scheduled run counts while the
 * shelf lists it (`listedRuns`): going now, or ended and not seen yet; a run
 * that never started has no session and is not in here.
 */
export function errandsBySession(
    merge: MergeManagerState,
    queueErrands: Readonly<Record<string, readonly QueueErrandView[]>>,
    triaging: readonly TriageErrandView[],
    schedules: ScheduleManagerFacts | null = null,
): ReadonlyMap<string, ErrandEntry> {
    const out = new Map<string, ErrandEntry>();
    const host = merge.merging?.kind === 'vm' ? merge.merging.vm.name : null;

    for (const lane of merge.lanes) {
        for (const pr of lane.pullRequests) {
            if (!pr.errand) continue;
            const {stage} = pr;
            let doing = 'finishing';
            let needsYou = false;
            if (stage.kind === 'fixing') doing = stage.cause === 'conflict' ? 'rebasing' : 'fixing checks';
            else if (stage.kind === 'needsYou' && stage.reason.kind === 'errand-stopped') {
                doing = stage.reason.question ? 'stopped: asks' : 'stopped';
                needsYou = true;
            } else if (stage.kind === 'merged') continue;
            out.set(pr.errand, {
                sessionId: pr.errand,
                kind: 'fix',
                owner: 'merge-manager',
                repository: pr.repository,
                number: pr.number,
                title: null,
                doing,
                needsYou,
                host,
            });
        }
    }

    for (const list of Object.values(queueErrands)) {
        for (const errand of list) {
            if (!errand.sessionId || errand.state === 'done') continue;
            const needsYou = errand.state === 'needs-you';
            out.set(errand.sessionId, {
                sessionId: errand.sessionId,
                kind: errand.kind,
                owner: 'queue',
                repository: errand.repository,
                number: errand.number,
                title: null,
                doing: needsYou ? 'stopped' : errand.kind === 'nudge' ? 'nudging the reviewer' : 'fixing',
                needsYou,
                host: null,
            });
        }
    }

    for (const triage of triaging) {
        out.set(triage.sessionId, {
            sessionId: triage.sessionId,
            kind: 'triage',
            owner: 'bug-manager',
            repository: triage.repository,
            number: null,
            title: triage.title,
            doing: triage.needsYou ? 'stopped' : 'triaging',
            needsYou: triage.needsYou,
            host: null,
        });
    }

    for (const run of listedRuns(schedules)) {
        if (!run.sessionId) continue;
        out.set(run.sessionId, {
            sessionId: run.sessionId,
            kind: 'scheduled',
            owner: 'schedule',
            repository: run.projectPath,
            number: null,
            title: run.name,
            doing: run.doing,
            needsYou: run.needsYou,
            host: run.host,
            run,
        });
    }
    return out;
}

/** Whether two entries say the same: every field alike, a scheduled run's included. */
export function sameErrand(a: ErrandEntry, b: ErrandEntry): boolean {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof ErrandEntry)[]);
    for (const key of keys) {
        if (key === 'run') continue;
        if (a[key] !== b[key]) return false;
    }
    if (!a.run || !b.run) return a.run === b.run;
    const runA = a.run;
    const runB = b.run;
    return (Object.keys(runA) as (keyof ShelfRun)[]).every((key) => runA[key] === runB[key]);
}
