/**
 * Errands in the sidebar: which sessions are errands, and what each is doing,
 * as the Errands shelf shows them.
 *
 * An errand is a session Switchboard started by itself: the Merge manager's
 * fix errands (#437) and the merge queue's Nudge and Fix (#315), each for a
 * pull request, and the Bug manager's quick triage, for a bug. A session the
 * user started is never one. Errands keep out of the
 * user's own sections and sit on a shelf docked under the session list;
 * only a stuck one also shows in Blocked, below the user's own rows.
 *
 * Pure: the caller hands in what main last pushed (the Merge manager's
 * lanes, the queue's errands and the bugs being triaged) and gets one index
 * keyed by session id.
 */
import type {TriageErrandView} from '../inbox/model';
import type {MergeManagerState} from '../merge-manager/model';
import type {QueueErrandView} from '../project/queue-errands';

/** What an errand does: a fix (wrench), a nudge (paper plane) or a triage (magnifier). */
export type ErrandKind = 'fix' | 'nudge' | 'triage';

/** Who started it. */
export type ErrandOwner = 'merge-manager' | 'queue' | 'bug-manager';

/** One errand's session, as the shelf and a stuck row in Blocked show it. */
export interface ErrandEntry {
    readonly sessionId: string;
    readonly kind: ErrandKind;
    readonly owner: ErrandOwner;
    /** `owner/repo`. */
    readonly repository: string;
    /** The pull request's number; null for a triage, which works on a bug. */
    readonly number: number | null;
    /** The bug's title (error class and message) for a triage; null for an errand on a pull request. */
    readonly title: string | null;
    /** What it is doing, in a few words: "fixing checks", "rebasing", "nudging the reviewer", "triaging", "stopped: asks". */
    readonly doing: string;
    /** Stuck: it stopped without finishing, and only the user can move it on. */
    readonly needsYou: boolean;
    /** The VM's name when the Merge manager's errands run on a VM merging was handed off to; null on this Mac. */
    readonly host: string | null;
}

const OWNER_NAMES: Readonly<Record<ErrandOwner, string>> = {
    'merge-manager': 'the Merge manager',
    queue: 'the merge queue',
    'bug-manager': 'the Bug manager',
};

/**
 * What the session header says of an open errand: "Errand for the Merge
 * manager · fixing checks on #431 · archives itself", or for a triage
 * "Errand for the Bug manager · triaging TypeError: x is undefined · archives
 * itself" ("stopped triaging …" once it stopped without a verdict).
 */
export function errandHeaderText(errand: ErrandEntry): string {
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
 * that stopped without a verdict needs you.
 */
export function errandsBySession(
    merge: MergeManagerState,
    queueErrands: Readonly<Record<string, readonly QueueErrandView[]>>,
    triaging: readonly TriageErrandView[],
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
    return out;
}
