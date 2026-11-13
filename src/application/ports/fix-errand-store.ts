/**
 * Where the Merge manager keeps its fix errands (#437), so an errand stays
 * one across a restart: which session works on which PR, the commit it failed
 * out on, and what it said when it finished, for the next errand's prompt.
 */
import type {FixErrand} from '../../domain/merge-manager/errands';

export interface FixErrandStore {
    /** Every errand, oldest first. */
    all(): FixErrand[];
    /** Write this errand, replacing the one with its id. */
    save(errand: FixErrand): void;
    /** Forget these errands. Unknown ids are ignored. */
    remove(ids: readonly string[]): void;
}
