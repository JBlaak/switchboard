/**
 * The merge queue on a sidebar row (#315): a short pill when the session's PR
 * is in its repository's queue (merging, 2nd, held, failed), the queue's
 * sentence on hover, and "errand · archives itself" on a Nudge or Fix in
 * session errand's row. Nothing at all for a row the queue knows nothing of.
 *
 * A landed PR (#436) shows its stage in the Merge manager's words instead
 * ("landed · 2nd", "held · @ana", "merging", "fixing", "needs you"), in
 * either lane.
 */
import type {JSX} from 'react';
import {sessionQueueMark} from '../../../domain/project/queue-elsewhere';
import {landedPill, sessionLanded} from '../../../domain/merge-manager/land-it';
import {useStore} from '../use-store';
import type {SessionRow} from '../../../domain/session/session';

export function QueueMark({session}: {session: SessionRow}): JSX.Element | null {
    const queues = useStore((state) => state.mergeQueue.queues);
    const errands = useStore((state) => state.mergeQueue.errands);
    const lanes = useStore((state) => state.mergeManager.state);
    const {pill, errand} = sessionQueueMark(session.sessionId, session.pullRequests ?? [], queues, errands);
    const landed = sessionLanded(session.pullRequests ?? [], lanes);
    const stage = landed ? landedPill(landed) : null;
    if (!stage && !pill && !errand) return null;
    return (
        <>
            {stage ? (
                <span
                    className={'session-land-pill is-' + stage.kind}
                    data-testid="session-land-pill"
                    title={stage.title}>
                    {stage.text}
                </span>
            ) : (
                pill && (
                    <span
                        className={'session-queue-pill is-' + pill.kind}
                        data-testid="session-queue-pill"
                        title={pill.title}>
                        {pill.text}
                    </span>
                )
            )}
            {errand && (
                <span className="session-errand" data-testid="session-errand">
                    {errand}
                </span>
            )}
        </>
    );
}
