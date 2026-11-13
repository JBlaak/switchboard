/**
 * Land it in the session header (#436): the session's newest open PR as a
 * pill ("PR #432", opening it on GitHub), and beside it Land it, or once it
 * is landed its stage with Unland in its menu. Nothing for a session without
 * an open PR of yours, or before `gh` has said how its PRs are doing.
 *
 * The PRs are read as the session goes on screen, and again after each push
 * of the lanes, so a PR the session opened since shows up.
 */
import {useEffect} from 'react';
import type {JSX} from 'react';
import {landOffer, sessionLandCandidate} from '../../../domain/merge-manager/land-it';
import {useStore} from '../use-store';
import {LandIt} from './LandIt';
import {loadSessionPullRequests} from './land-actions';

export function HeaderLandIt({sessionId}: {sessionId: string}): JSX.Element | null {
    const prs = useStore((state) => state.mergeManager.sessionPullRequests[sessionId]);
    const lanes = useStore((state) => state.mergeManager.state);

    useEffect(() => {
        void loadSessionPullRequests(sessionId);
    }, [sessionId, lanes]);

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
            <LandIt pr={candidate} />
        </span>
    );
}
