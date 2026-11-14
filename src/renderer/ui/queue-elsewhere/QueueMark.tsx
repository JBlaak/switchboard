/**
 * The merge queue on a sidebar row (#315): a short pill when the session's PR
 * is landed (its stage, in the words every place shares, #441) or in its
 * repository's queue (merging, 2nd, held, failed), and the queue's
 * sentence on hover. Nothing at all for a row the queue knows nothing of.
 *
 * An errand's row no longer carries a pill of its own: errands live on the
 * Errands shelf, and an errand row elsewhere says so itself (`RowMeta`).
 */
import type {JSX} from 'react';
import {sessionQueueMark} from '../../../domain/project/queue-elsewhere';
import {useStore} from '../use-store';
import type {SessionRow} from '../../../domain/session/session';

export function QueueMark({session}: {session: SessionRow}): JSX.Element | null {
    const queues = useStore((state) => state.mergeQueue.queues);
    const errands = useStore((state) => state.mergeQueue.errands);
    const merge = useStore((state) => state.mergeManager.state);
    const {pill} = sessionQueueMark(session.sessionId, session.pullRequests ?? [], queues, errands, merge);
    if (!pill) return null;
    return (
        <span className={'session-queue-pill is-' + pill.kind} data-testid="session-queue-pill" title={pill.title}>
            {pill.text}
            {pill.flag && <span className="session-queue-flag"> · {pill.flag}</span>}
        </span>
    );
}
