/**
 * The counters behind the Merge manager's "CI runs saved" estimate (#435,
 * shown by #439): what the Switchboard lane runner did not spend.
 */
import type {LaneSaving} from '../../domain/merge-manager/model';

export interface LaneSavings {
    /** Count `count` savings of `kind` in `repository` at `at` (epoch ms). */
    add(repository: string, kind: LaneSaving, count: number, at: number): void;
    /** Every saving of each kind since `at`, all repositories together. */
    since(at: number): Record<LaneSaving, number>;
    /** Every saving of each kind since `at`, by lower-case `owner/repo` (#439). */
    byRepository(at: number): Record<string, Record<LaneSaving, number>>;
}
