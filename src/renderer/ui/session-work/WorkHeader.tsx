/**
 * The page's header: Back, `Work · <session name>`, where the work lives and
 * how fresh it is, and the strip of agents working (D11, D16).
 *
 * Nothing in the first row's title or the agents strip needs git, so both
 * show the moment the page opens; the repository and counts wait for the
 * first snapshot.
 *
 * A PR's own page (`pull:…`) has no session: it is titled by the PR, and
 * leaves out what only a session has — its agents, its worktree and branch
 * counts, the terminal Back goes to, Cmd+G, the tabs and the task link.
 */
import type {JSX} from 'react';
import {useStore} from '../use-store';
import {shallowEqual} from '../../state/store';
import {closeSessionWork, openOnGitHub, setWorkTab} from './actions';
import {agentsLabel, footprintLine, updatedAgo, workPageTitle} from './describe';
import {isPullRequestPageId} from '../../../domain/session-work/pull-request-link';
import type {SessionWorkPage, WorkTab} from '../../state/session-work-slice';
import type {WorkingAgent} from '../../../domain/terminal/program-status-children';
import {LinkTaskButton} from '../session-task/LinkTask';

const NO_AGENTS: readonly WorkingAgent[] = [];

const TABS: readonly {tab: WorkTab; label: string}[] = [
    {tab: 'work', label: 'Work'},
    {tab: 'plan', label: 'Plan'},
    {tab: 'task', label: 'Task'},
];

/** `tabs` are the ones this session's page has: Task only while it works on one (#250). */
export function WorkHeader({
    page,
    tab,
    tabs,
}: {
    page: SessionWorkPage;
    tab: WorkTab;
    tabs: readonly WorkTab[];
}): JSX.Element {
    const now = useStore((state) => state.sessionWork.now);
    const pullPage = isPullRequestPageId(page.sessionId);
    const agents = useStore(
        (state) => (pullPage ? NO_AGENTS : (state.activity.agents[page.sessionId] ?? NO_AGENTS)),
        shallowEqual,
    );
    const {snapshot} = page;
    const repository = snapshot ? snapshot.repository : '';

    return (
        <header className="sw-header">
            <div className="sw-header-row">
                <button
                    type="button"
                    className="sw-btn sw-back"
                    onClick={closeSessionWork}
                    aria-label={pullPage ? 'Back (Esc)' : 'Back to terminal (Esc)'}>
                    <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true">
                        <path d="M15 18l-6-6 6-6" />
                    </svg>
                    {pullPage ? 'Back' : 'Terminal'} <kbd className="sw-kbd">esc</kbd>
                </button>
                <div className="sw-heading">
                    <h1 className="sw-title">{workPageTitle(page)}</h1>
                    <div className="sw-subline">
                        {repository && (
                            <a
                                className="sw-repo"
                                href={'https://github.com/' + repository}
                                onClick={(e) => {
                                    e.preventDefault();
                                    openOnGitHub('https://github.com/' + repository);
                                }}>
                                {repository}
                            </a>
                        )}
                        {snapshot && !pullPage && <span>{footprintLine(snapshot)}</span>}
                        {snapshot && <span className="sw-updated">{updatedAgo(snapshot.updatedAt, now)}</span>}
                    </div>
                </div>
                {!pullPage && (
                    <kbd className="sw-kbd" title="Cmd+G toggles this page">
                        ⌘G
                    </kbd>
                )}
            </div>
            {agents.length > 0 && (
                <div className="sw-agents" data-testid="session-work-agents">
                    <span className="sw-pill is-lavender">
                        <svg
                            width="11"
                            height="11"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.4"
                            strokeLinecap="round"
                            aria-hidden="true">
                            <circle cx="8" cy="8" r="3" />
                            <circle cx="17" cy="9" r="2.5" />
                            <path d="M3 20c0-3 2.5-5 5-5s5 2 5 5M14 19c0-2.4 1.5-4 3-4s3 1.6 3 4" />
                        </svg>
                        {agentsLabel(agents.length)}
                    </span>
                    {agents.map((agent, i) => (
                        <span key={agent.id} className="sw-agent">
                            {i > 0 && (
                                <span className="sw-sep" aria-hidden="true">
                                    ·
                                </span>
                            )}
                            {agent.title || 'Untitled agent'}
                        </span>
                    ))}
                </div>
            )}
            {!pullPage && (
                <div className="sw-tabs" role="tablist" aria-label="Session work">
                    {TABS.filter(({tab: id}) => tabs.includes(id)).map(({tab: id, label}) => (
                        <button
                            key={id}
                            type="button"
                            role="tab"
                            className={'sw-tab' + (tab === id ? ' is-current' : '')}
                            aria-selected={tab === id}
                            onClick={() => setWorkTab(id)}>
                            {label}
                        </button>
                    ))}
                    <kbd className="sw-kbd" title="t switches tabs">
                        t
                    </kbd>
                    <LinkTaskButton sessionId={page.sessionId} />
                </div>
            )}
        </header>
    );
}
