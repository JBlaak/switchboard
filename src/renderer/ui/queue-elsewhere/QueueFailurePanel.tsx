/**
 * The strip between a session's header and its terminal when the session's
 * own PR left the merge queue (#315): "#N left the queue", the failing check
 * and the queue's reason, and Fix in session, Open the PR and Retry.
 *
 * It renders into `#terminal-queue-panel`, a sibling of `#terminals`, and
 * shows and hides that container itself; the terminal on screen is refitted
 * whenever it does, since the strip takes its height from the terminal's.
 */
import {useLayoutEffect} from 'react';
import type {JSX} from 'react';
import {sessionQueueFailure} from '../../../domain/project/queue-elsewhere';
import {queueActionKey} from '../../state/merge-queue-slice';
import {sessionMap} from '../../state/session-store';
import {refitOpenTerminals} from '../../features/terminal/terminal-manager';
import {useStore} from '../use-store';
import {fixInSession, openTheRun, retryInQueue} from './actions';

export function QueueFailurePanel(): JSX.Element | null {
    const onScreen = useStore((state) => state.terminal.onScreen);
    const queues = useStore((state) => state.mergeQueue.queues);
    const actions = useStore((state) => state.mergeQueue.actions);
    // The row is shared; its PRs change with a re-fetch, which a queue push follows.
    const row = onScreen ? sessionMap.get(onScreen) : undefined;
    const failure = row ? sessionQueueFailure(row.pullRequests ?? [], queues) : null;
    const shown = failure !== null;

    useLayoutEffect(() => {
        const container = document.getElementById('terminal-queue-panel');
        if (!container || container.hidden === !shown) return;
        container.hidden = !shown;
        refitOpenTerminals();
    }, [shown]);

    if (!failure || !row) return null;
    const {entry} = failure;
    const action = actions[queueActionKey(failure.repository, failure.number)];
    const busy = action?.phase === 'busy';
    const fixed = action?.action === 'fix' && action.phase === 'done';
    const detail = entry.failingCheck ? entry.reason : null;

    return (
        <section className="queue-failure" data-testid="queue-failure-panel" aria-label={failure.heading}>
            <div className="queue-failure-text">
                <span className="queue-failure-pill">{failure.heading}</span>
                <span className="queue-failure-summary">
                    {entry.failingCheck ? (
                        <>
                            <strong>{entry.failingCheck}</strong> failed as the head of the queue
                        </>
                    ) : (
                        failure.summary
                    )}
                </span>
                {detail && <span className="queue-failure-reason">{detail}</span>}
                <span className="queue-failure-note" role="status">
                    {action && action.phase !== 'busy' ? action.text : entry.rejoins}
                </span>
            </div>
            <div className="queue-failure-actions">
                <button
                    type="button"
                    className="sw-btn sw-btn-small is-accent"
                    aria-disabled={busy || fixed}
                    onClick={() => {
                        if (!busy && !fixed) void fixInSession(row.projectPath, failure);
                    }}>
                    {busy && action.action === 'fix' ? 'Sending…' : fixed ? 'Sent' : 'Fix in session'}
                </button>
                <button type="button" className="sw-btn sw-btn-small" onClick={() => openTheRun(failure)}>
                    Open the PR
                </button>
                <button
                    type="button"
                    className="sw-btn sw-btn-small"
                    aria-disabled={busy}
                    onClick={() => {
                        if (!busy) void retryInQueue(failure);
                    }}>
                    {busy && action.action === 'retry' ? 'Retrying…' : 'Retry'}
                </button>
            </div>
        </section>
    );
}
