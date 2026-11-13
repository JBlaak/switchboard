/**
 * Where the managers' inbox is kept (#413): every item with its state, notes
 * and what the last poll read of it, and when each source was first synced.
 * Switchboard's own state, never written anywhere else.
 */
import type {InboxItem} from '../../domain/inbox/model';

export interface InboxStore {
    /** Every item, of both managers. */
    all(): InboxItem[];
    /** Write these items (replacing the ones with their keys) and drop those keys, in one go. */
    apply(save: readonly InboxItem[], remove: readonly string[]): void;
    /** When a source (a Bugsnag project id, an `owner/repo`) was first synced, epoch ms; null before. */
    watchingSince(source: string): number | null;
    setWatchingSince(source: string, at: number): void;
}
