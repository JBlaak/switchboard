/**
 * The VM's Merge manager stores (#442) over its one lane state file
 * (`domain/agent/lane-state`): the landed PRs, the fix errands and the
 * savings that the Mac keeps in SQLite. Each change is written whole at once;
 * a write that fails is logged and the state kept for this run.
 */
import {
    parseLaneState,
    savingsByRepository,
    serializeLaneState,
    withSaving,
    type LaneState,
} from '../../../domain/agent/lane-state';
import type {FixErrand} from '../../../domain/merge-manager/errands';
import type {LandedPullRequest, LaneSaving} from '../../../domain/merge-manager/model';
import type {Clock} from '../../ports/clock';
import type {FixErrandStore} from '../../ports/fix-errand-store';
import type {LandedStore} from '../../ports/landed-store';
import type {LaneSavings} from '../../ports/lane-savings';
import type {Logger} from '../../ports/logger';
import type {RecordFile} from '../../ports/record-file';

/** The landed PRs and savings directly; the errands as `errandStore`, since both stores have an `all`. */
export class LaneStateStore implements LandedStore, LaneSavings {
    private state: LaneState | null = null;

    constructor(private readonly deps: {file: RecordFile; clock: Clock; log: Logger}) {}

    /** The state as it is now. */
    public current(): LaneState {
        this.state ??= parseLaneState(this.deps.file.read());
        return this.state;
    }

    // ── Landed PRs ──

    public all(): LandedPullRequest[] {
        return [...this.current().landed];
    }

    public apply(save: readonly LandedPullRequest[], remove: readonly string[]): void {
        const gone = new Set([...remove, ...save.map((pr) => pr.key)]);
        const landed = [...this.current().landed.filter((pr) => !gone.has(pr.key)), ...save];
        this.write({...this.current(), landed});
    }

    // ── Fix errands ──

    public errands(): FixErrand[] {
        return [...this.current().errands].sort((a, b) => a.startedAt - b.startedAt);
    }

    public saveErrand(errand: FixErrand): void {
        const errands = [...this.current().errands.filter((e) => e.id !== errand.id), errand];
        this.write({...this.current(), errands});
    }

    public removeErrands(ids: readonly string[]): void {
        const gone = new Set(ids);
        this.write({...this.current(), errands: this.current().errands.filter((e) => !gone.has(e.id))});
    }

    /** As the fix errands' store: `all`, `save` and `remove` over the errands. */
    public readonly errandStore: FixErrandStore = {
        all: () => this.errands(),
        save: (errand) => this.saveErrand(errand),
        remove: (ids) => this.removeErrands(ids),
    };

    // ── Savings ──

    public add(repository: string, kind: LaneSaving, count: number, at: number): void {
        this.write(withSaving(this.current(), {repository, kind, count, at}, this.deps.clock.now()));
    }

    public since(at: number): Record<LaneSaving, number> {
        const total: Record<LaneSaving, number> = {'update-not-pushed': 0, 'run-cancelled': 0, 'conflict-found': 0};
        for (const counts of Object.values(this.byRepository(at))) {
            for (const kind of Object.keys(total) as LaneSaving[]) total[kind] += counts[kind];
        }
        return total;
    }

    public byRepository(at: number): Record<string, Record<LaneSaving, number>> {
        return savingsByRepository(this.current(), at);
    }

    // ── Flags ──

    public get noWorkflowScope(): boolean {
        return this.current().noWorkflowScope;
    }

    public setNoWorkflowScope(value: boolean): void {
        if (this.current().noWorkflowScope !== value) this.write({...this.current(), noWorkflowScope: value});
    }

    private write(next: LaneState): void {
        this.state = next;
        try {
            this.deps.file.write(serializeLaneState(next));
        } catch (err) {
            this.deps.log.error('[merge-host] could not save the lane state', err);
        }
    }
}
