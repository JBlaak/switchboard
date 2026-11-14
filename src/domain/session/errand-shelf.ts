/**
 * Errands in the sidebar: which sessions are errands, and what each is doing,
 * as the Errands shelf shows them.
 *
 * An errand is a session Switchboard started by itself for a pull request:
 * the Merge manager's fix errands (#437) and the merge queue's Nudge and Fix
 * (#315). A session the user started is never one. Errands keep out of the
 * user's own sections and sit on a shelf docked under the session list;
 * only a stuck one also shows in Blocked, below the user's own rows.
 *
 * Pure: the caller hands in what main last pushed (the Merge manager's
 * lanes and the queue's errands) and gets one index keyed by session id.
 */
import type {MergeManagerState} from '../merge-manager/model';
import type {QueueErrandView} from '../project/queue-errands';

/** What an errand does: a fix (wrench) or a nudge (paper plane). */
export type ErrandKind = 'fix' | 'nudge';

/** Who started it. */
export type ErrandOwner = 'merge-manager' | 'queue';

/** One errand's session, as the shelf and a stuck row in Blocked show it. */
export interface ErrandEntry {
    readonly sessionId: string;
    readonly kind: ErrandKind;
    readonly owner: ErrandOwner;
    /** `owner/repo`. */
    readonly repository: string;
    readonly number: number;
    /** What it is doing, in a few words: "fixing checks", "rebasing", "nudging the reviewer", "stopped: asks". */
    readonly doing: string;
    /** Stuck: it stopped without finishing, and only the user can move it on. */
    readonly needsYou: boolean;
    /** The VM's name when the Merge manager's errands run on a VM merging was handed off to; null on this Mac. */
    readonly host: string | null;
}

/** What the session header says of an open errand: "Errand for the Merge manager · fixing checks on #431 · archives itself". */
export function errandHeaderText(errand: ErrandEntry): string {
    const owner = errand.owner === 'merge-manager' ? 'the Merge manager' : 'the merge queue';
    return `Errand for ${owner} · ${errand.doing} on #${errand.number} · archives itself`;
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
 * from the moment the renderer started its session until it is done.
 */
export function errandsBySession(
    merge: MergeManagerState,
    queueErrands: Readonly<Record<string, readonly QueueErrandView[]>>,
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
                doing: needsYou ? 'stopped' : errand.kind === 'nudge' ? 'nudging the reviewer' : 'fixing',
                needsYou,
                host: null,
            });
        }
    }
    return out;
}
