/**
 * A session's own state, as the user sets it: its name, its pin and whether
 * it is archived. The Mac's IPC handlers and a phone's row actions (#381) both
 * come through here, so a rename from either side updates the search index the
 * same way, and a pin means the same star.
 *
 * A session's pin is its star in the store (`toggleStar`); the sidebar calls
 * it a pin.
 */
import {searchTitleFor} from '../../domain/session/title';
import type {PinRef} from '../../domain/pin/pin-order';
import type {SearchIndex} from '../ports/search-index';
import type {SessionRepository} from '../ports/session-repository';
import type {PinOrderService} from './pin-order-service';

export interface SessionMetaServiceDeps {
    repository: Pick<SessionRepository, 'setName' | 'getCachedSession' | 'getMeta' | 'toggleStar' | 'setArchived'>;
    searchIndex: Pick<SearchIndex, 'updateTitle'>;
    /** Places a pin at the end of Pinned, and takes an unpin out, whichever side pinned it (#379). */
    pinOrder: Pick<PinOrderService, 'toggle'>;
}

export class SessionMetaService {
    constructor(private readonly deps: SessionMetaServiceDeps) {}

    /**
     * Rename a session, or clear its name with null (or an empty one).
     *
     * The search index carries the name as part of its title, so a rename has
     * to update it or the session stops being findable under its new name
     * until the next re-index.
     */
    public rename(sessionId: string, name: string | null): {name: string | null} {
        const {repository, searchIndex} = this.deps;
        const stored = name || null;
        repository.setName(sessionId, stored);
        const summary = repository.getCachedSession(sessionId)?.summary || '';
        searchIndex.updateTitle(sessionId, 'session', searchTitleFor({storedName: stored}, summary));
        return {name: stored};
    }

    /** Flip the pin, as the row's pin button does; answers the value it settled on and Pinned's order after it. */
    public toggleStar(sessionId: string): {starred: 0 | 1; order: PinRef[]} {
        const {result, order} = this.flipPin(sessionId);
        return {starred: result, order};
    }

    /**
     * Pin or unpin. Asked for the state it should end in rather than a flip, so
     * a pin sent twice (a phone's retry, two phones at once) stays pinned.
     */
    public setPinned(sessionId: string, pinned: boolean): 0 | 1 {
        const now = this.deps.repository.getMeta(sessionId)?.starred ? 1 : 0;
        if (Boolean(now) === pinned) return now;
        return this.flipPin(sessionId).result;
    }

    private flipPin(sessionId: string): {result: 0 | 1; order: PinRef[]} {
        return this.deps.pinOrder.toggle(
            'sessions',
            {kind: 'session', sessionId},
            () => this.deps.repository.toggleStar(sessionId),
            (starred) => starred === 1,
        );
    }

    /** Bring an archived row back into the list, as the archive toast's Undo does. */
    public unarchive(sessionId: string): void {
        this.deps.repository.setArchived(sessionId, false);
    }
}
