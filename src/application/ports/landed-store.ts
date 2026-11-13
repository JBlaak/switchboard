/**
 * Where the Merge manager keeps its landed PRs (#434), so a landed PR, its
 * place in its lane and its errand survive a restart. Switchboard's own
 * state; GitHub only ever sees the queue's labels.
 */
import type {LandedPullRequest} from '../../domain/merge-manager/model';

export interface LandedStore {
    /** Every landed PR, merged ones still kept included. */
    all(): LandedPullRequest[];
    /** Write these PRs (replacing the ones with their keys) and drop those keys, in one go. */
    apply(save: readonly LandedPullRequest[], remove: readonly string[]): void;
}
