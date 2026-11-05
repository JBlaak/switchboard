/**
 * What the session header's merge queue panel (#315) does: Fix in session,
 * Retry and Open the run. The panel calls these and nothing else.
 */
import {dispatch} from '../../state/app-store';
import {startClaudeSessionIn} from '../../features/sessions/session-actions';
import {resolveDefaultSessionOptions} from '../../features/dialogs/launch-options';
import {fixInSessionWith, type FixInSessionSteps} from './fix-in-session';
import {failedPullRequest, retriedPullRequest, type SessionQueueFailure} from '../../../domain/project/queue-elsewhere';

const steps: FixInSessionSteps = {
    fix: (request) => window.api.queueFix(request),
    defaultOptions: resolveDefaultSessionOptions,
    launch: (projectPath, options, how) => startClaudeSessionIn(projectPath, options, how),
    started: (errandId, sessionId) => window.api.queueErrandStarted(errandId, sessionId),
    abandoned: (errandId) => window.api.queueErrandAbandoned(errandId),
};

/** Hand the queue's failure to Claude: this session when it owns the PR, else a new errand session. */
export async function fixInSession(
    sessionId: string,
    projectPath: string,
    failure: SessionQueueFailure,
): Promise<void> {
    const {repository, number} = failure;
    dispatch({type: 'queuePanelActionStarted', repository, number, action: 'fix'});
    const outcome = await fixInSessionWith(steps, {sessionId, projectPath, failure});
    dispatch({type: 'queuePanelActionFinished', repository, number, action: 'fix', ...outcome});
}

/** Put the PR back in the queue: removes `automerge:failed` from the PR carrying it (a stack's top). */
export async function retryInQueue(failure: SessionQueueFailure): Promise<void> {
    const {repository, number} = failure;
    dispatch({type: 'queuePanelActionStarted', repository, number, action: 'retry'});
    const result = await window.api
        .queueRetry(repository, retriedPullRequest(failure))
        .catch((err: Error) => ({ok: false as const, reason: err.message || 'Could not retry'}));
    dispatch({
        type: 'queuePanelActionFinished',
        repository,
        number,
        action: 'retry',
        ok: result.ok,
        text: result.ok ? 'Back in the queue on its next pass' : result.reason,
    });
}

/**
 * The failed run on GitHub. The queue's view names the failing check but not
 * its run, so a CI failure opens the PR's Checks tab, and anything else the PR.
 */
export function openTheRun(failure: SessionQueueFailure): void {
    const {url} = failedPullRequest(failure);
    void window.api.openExternal(failure.entry.kind === 'ci' ? url + '/checks' : url);
}
