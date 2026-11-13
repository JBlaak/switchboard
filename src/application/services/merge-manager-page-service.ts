/**
 * What the Merge manager's page (#439) shows besides the lanes, asked for as
 * it opens and as the lanes change: the CI the Switchboard lane runner saved
 * this week (#435's counters), in all and by repository; the fix errands
 * (#437), for the Fixing and Needs you detail; and each lane's local checkout,
 * where a Nudge's session starts.
 */
import {fixErrandState, type FixErrand} from '../../domain/merge-manager/errands';
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
    clock: Clock;
}

export class MergeManagerPageService {
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
        };
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
