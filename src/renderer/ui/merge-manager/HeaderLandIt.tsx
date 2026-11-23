/**
 * Land it in the session header (#436): the session's newest open PR as a
 * pill ("PR #432", opening it on GitHub), and beside it Land it, or once it
 * is landed its stage with Unland in its menu. Nothing for a session without
 * an open PR of yours, or before `gh` has said how its PRs are doing.
 *
 * Its rocket takes off from the session's row in the sidebar, never from up
 * here: none when the row is off screen.
 *
 * The PRs are read as the session goes on screen, again after each push of
 * the lanes, and again when the CI watch pushes news of the session's PRs:
 * it finds a PR the session opened since within its minute, local or on a
 * VM, with `gh`'s answer already in hand, while the lanes may not move at all.
 */
import {useEffect} from 'react';
import type {JSX} from 'react';
import {landOffer, sessionLandCandidate} from '../../../domain/merge-manager/land-it';
import {useStore} from '../use-store';
import {LandIt} from './LandIt';
import {loadSessionPullRequests, sessionRowInSight} from './land-actions';

export function HeaderLandIt({sessionId}: {sessionId: string}): JSX.Element | null {
    const prs = useStore((state) => state.mergeManager.sessionPullRequests[sessionId]);
    const lanes = useStore((state) => state.mergeManager.state);
    const ci = useStore((state) => state.ciStatus.bySession[sessionId]);

    useEffect(() => {
        void loadSessionPullRequests(sessionId);
    }, [sessionId, lanes, ci]);

    const candidate = prs ? sessionLandCandidate(prs) : null;
    if (!candidate || !landOffer(candidate, lanes)) return null;
    const pr = prs!.find((p) => p.number === candidate.number && p.repository === candidate.repository)!;
    return (
        <span className="header-land" data-testid="header-land">
            <a
                className="header-pr-pill"
                href={pr.url}
                title={pr.title}
                onClick={(e) => {
                    e.preventDefault();
                    void window.api.openExternal(pr.url);
                }}>
                PR #{pr.number}
                {candidate.state === 'draft' ? ' · draft' : ''}
            </a>
            <LandIt pr={candidate} launchFrom={() => sessionRowInSight(sessionId)} />
        </span>
    );
}
