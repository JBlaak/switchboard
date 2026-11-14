/**
 * What the Merge manager's page (#439) shows besides the lanes, asked for as
 * it opens and as the lanes change: the CI the Switchboard lane runner saved
 * this week (#435's counters), in all and by repository; the fix errands
 * (#437), for the Fixing and Needs you detail; each lane's local checkout,
 * where a Nudge's session starts; and one CI run in each lane's repository,
 * the median of its green runs, for the times. Run durations are read again
 * once they are a quarter of an hour old, not on every change of the lanes.
 */
import {fixErrandState, type FixErrand} from '../../domain/merge-manager/errands';
import {medianRunMs} from '../../domain/project/merge-queue';
import {weekStart, type ErrandView, type MergeManagerPageFacts} from '../../domain/merge-manager/page';
import type {MergeManagerState} from '../../domain/merge-manager/model';
import type {Clock} from '../ports/clock';
import type {LaneSavings} from '../ports/lane-savings';

export interface MergeManagerPageServiceDeps {
    manager: {state(): MergeManagerState};
    errands: {errands(): FixErrand[]};
    savings: Pick<LaneSavings, 'since' | 'byRepository'>;
    /** The local checkout of `owner/repo`; null when there is none. */
    checkoutOf(repository: string): Promise<string | null>;
    /** The durations of a repository's recent green CI runs; null when `gh` could not say. */
    ciRunDurations(repository: string): Promise<number[] | null>;
    clock: Clock;
}

/** How long a repository's run durations are kept before they are read again. */
export const RUN_TIMES_FRESH_MS = 15 * 60_000;

export class MergeManagerPageService {
    /** Lower-case `owner/repo` → one CI run there and when it was read. */
    private readonly runTimesRead = new Map<string, {at: number; runMs: number | null}>();

    constructor(private readonly deps: MergeManagerPageServiceDeps) {}

    public async facts(): Promise<MergeManagerPageFacts> {
        const since = weekStart(this.deps.clock.now());
        const checkouts: Record<string, string> = {};
        for (const lane of this.deps.manager.state().lanes) {
            const repository = lane.repository.toLowerCase();
            if (repository in checkouts) continue;
            const checkout = await this.deps.checkoutOf(lane.repository).catch(() => null);
            if (checkout) checkouts[repository] = checkout;
        }
        return {
            savedThisWeek: this.deps.savings.since(since),
            savedByRepository: this.deps.savings.byRepository(since),
            errands: this.deps.errands.errands().map(errandView),
            checkouts,
            runMs: await this.runTimes(this.deps.manager.state().lanes.map((lane) => lane.repository)),
        };
    }

    /** One CI run in each repository, by lower-case `owner/repo`: read again once it is stale, else kept. */
    public async runTimes(repositories: readonly string[]): Promise<Record<string, number | null>> {
        const now = this.deps.clock.now();
        const out: Record<string, number | null> = {};
        for (const name of repositories) {
            const repository = name.toLowerCase();
            if (repository in out) continue;
            let read = this.runTimesRead.get(repository);
            if (!read || now - read.at >= RUN_TIMES_FRESH_MS) {
                const durations = await this.deps.ciRunDurations(name).catch(() => null);
                // A failed read keeps the last good one, and is tried again next time.
                read = durations ? {at: now, runMs: medianRunMs(durations)} : (read ?? {at: 0, runMs: null});
                if (durations) this.runTimesRead.set(repository, read);
            }
            out[repository] = read.runMs;
        }
        return out;
    }
}

export function errandView(errand: FixErrand): ErrandView {
    return {
        key: errand.key,
        sessionId: errand.currentId,
        cause: errand.cause,
        startedAt: errand.startedAt,
        state: fixErrandState(errand),
        note: errand.finished?.note ?? null,
    };
}
