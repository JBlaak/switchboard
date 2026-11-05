/**
 * Fix in session from a session's header panel (#315), kept free of the
 * terminal and the DOM so the sequence is tested in node with fakes;
 * `actions.ts` hands it the real steps.
 *
 * Main decides where the fix goes. From the PR's own session's header that is
 * almost always that session (`queued`). When main answers `start` instead (no
 * running session owns the PR), the renderer starts the errand's session in
 * the worktree main prepared, without putting it on screen, and says which it
 * is; a session that would not start abandons the errand.
 */
import {failedPullRequest, type SessionQueueFailure} from '../../../domain/project/queue-elsewhere';
import type {ErrandResult, FixRequest, FixResult} from '../../../domain/project/queue-errands';
import type {SessionOptions} from '../../../domain/launch/session-options';

export interface FixInSessionSteps {
    fix(request: FixRequest): Promise<FixResult>;
    defaultOptions(projectPath: string): Promise<SessionOptions>;
    launch(
        projectPath: string,
        options: SessionOptions,
        how: {show: boolean},
    ): Promise<{ok: true; sessionId: string} | {ok: false; reason: string}>;
    started(errandId: string, sessionId: string): Promise<ErrandResult>;
    abandoned(errandId: string): Promise<ErrandResult>;
}

/** What the panel says once the fix is on its way, or why it is not. */
export type FixInSessionOutcome = {ok: true; text: string} | {ok: false; text: string};

export async function fixInSessionWith(
    steps: FixInSessionSteps,
    {sessionId, projectPath, failure}: {sessionId: string; projectPath: string; failure: SessionQueueFailure},
): Promise<FixInSessionOutcome> {
    const {entry} = failure;
    let result: FixResult;
    try {
        result = await steps.fix({
            repository: failure.repository,
            projectPath,
            pr: failedPullRequest(failure),
            failure: {kind: entry.kind, reason: entry.reason, checkName: entry.failingCheck},
        });
    } catch (err) {
        return {ok: false, text: (err as Error).message || 'Could not hand the fix over'};
    }
    if (!result.ok) return {ok: false, text: result.reason};
    if (result.kind === 'queued') {
        return {
            ok: true,
            text:
                result.sessionId === sessionId
                    ? 'Sent to this session: it fixes and pushes, and stays open'
                    : 'Sent to the PR’s own session',
        };
    }

    // The session is in its worktree already; `--worktree` would make another.
    const {worktree: _worktree, worktreeName: _worktreeName, ...defaults} = await steps.defaultOptions(projectPath);
    const launched = await steps.launch(
        result.worktreePath,
        {...defaults, initialPrompt: result.prompt},
        {show: false},
    );
    if (!launched.ok) {
        await steps.abandoned(result.errandId).catch(() => undefined);
        return {ok: false, text: launched.reason};
    }
    await steps.started(result.errandId, launched.sessionId).catch(() => undefined);
    return {ok: true, text: 'Fixing in a new session on ' + result.branch + ', which archives itself'};
}
