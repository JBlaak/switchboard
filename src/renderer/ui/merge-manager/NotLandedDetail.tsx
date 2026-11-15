/**
 * A Not landed row's side view, in the lanes' side view frame (`.mm-detail`):
 * its pill and repository, its title and a link to it on GitHub; what stands
 * between it and merging (checks, conflicts with its base, approval); what
 * landing it now would do; and Land it (L, not for a draft), Open session (⏎,
 * only when a session in the list opened it) and Open on GitHub (O).
 */
import type {JSX} from 'react';
import {
    canLand,
    notLandedStatus,
    repositoryShortName,
    type OpenPullRequest,
} from '../../../domain/merge-manager/not-landed';
import {CloseIcon} from './CloseIcon';
import {NotLandedLandIt, NotLandedPill} from './NotLandedRow';
import {beforeMerge, ifLandedNow, type BeforeMergeItem} from './not-landed-rows';
import {closeMergeDetail, openRowOnGitHub, sessionOf} from './page-actions';
import {openNotLandedSession} from './not-landed-actions';

const MARK: Record<BeforeMergeItem['tone'], string> = {
    done: '✓',
    running: '◌',
    waiting: '◌',
    failing: '✗',
    warn: '!',
    none: '–',
};

export function NotLandedDetail({pr, busy}: {pr: OpenPullRequest; busy: boolean}): JSX.Element {
    const session = sessionOf(pr);
    return (
        <aside className="mm-detail" aria-label={`#${pr.number} ${pr.title}`}>
            <div className="mm-detail-bar">
                <div className="mm-detail-where">
                    <NotLandedPill status={notLandedStatus(pr)} />
                    <span>{repositoryShortName(pr.repository)} · not landed</span>
                </div>
                <button
                    type="button"
                    className="im-close"
                    onClick={closeMergeDetail}
                    aria-label="Close the side view (Esc)">
                    <CloseIcon />
                </button>
            </div>
            <h2 className="mm-title">
                #{pr.number} {pr.title}
            </h2>
            <button type="button" className="im-out mm-out" onClick={() => openRowOnGitHub(pr)}>
                Open PR #{pr.number} on GitHub ↗
            </button>
            <div className="im-box">
                <span className="im-box-label">Before it can merge</span>
                <div className="mm-checks mm-nl-checklist">
                    {beforeMerge(pr).map((item) => (
                        <div key={item.text} className={'is-' + item.tone}>
                            {MARK[item.tone]} <span>{item.text}</span>
                        </div>
                    ))}
                </div>
            </div>
            <div className="im-box">
                <span className="im-box-label">If you land it now</span>
                <p>{ifLandedNow(pr)}</p>
            </div>
            <div className="im-actions">
                {canLand(pr) && <NotLandedLandIt pr={pr} primary busy={busy} shortcut />}
                {session && (
                    <button type="button" className="sw-btn" onClick={() => void openNotLandedSession(pr)}>
                        Open session <kbd className="sw-kbd">↵</kbd>
                    </button>
                )}
                <button type="button" className="sw-btn is-ghost" onClick={() => openRowOnGitHub(pr)}>
                    Open on GitHub <kbd className="sw-kbd">O</kbd>
                </button>
            </div>
        </aside>
    );
}
