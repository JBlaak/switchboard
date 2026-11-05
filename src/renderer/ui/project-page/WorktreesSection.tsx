/**
 * The project page's Worktrees section (#175), under Sessions: the main
 * checkout first, then the rest by their last commit. Each row shows its
 * branch, then its changes, how far it is ahead and its PR, with a dot while a
 * session runs there. Start session (on hover or under the cursor, or S)
 * starts one in a worktree with none, and the page stays on screen. A merged
 * worktree is dimmed and marked safe to remove. Clean, by the heading, removes
 * the merged ones with no changes and no session running, after a confirm;
 * one git would not remove says so on its row. No Clean for an ssh project.
 *
 * Reads the overview, so it shimmers until the first answer. Left out for a
 * project with no checkouts (not a git repository) and for an agentless
 * remote one; a VM project's (#276) are read on the VM.
 */
import type {JSX} from 'react';
import {useStore} from '../use-store';
import {cursorId, worktreesView} from './page-rows';
import {cleanableWorktrees, showsWorktrees} from './page-state';
import {cleanWorktrees, startWorktreeSession} from './actions';
import {SectionSkeleton} from './SectionSkeleton';
import {isVmProjectIn} from '../../state/agent-host-slice';

export function WorktreesSection({projectPath}: {projectPath: string}): JSX.Element | null {
    const page = useStore((state) => state.projectPage);
    const vm = useStore((state) => isVmProjectIn(state.agentHost, projectPath));
    if (!showsWorktrees(page.overview, projectPath, vm)) return null;
    const answered = page.overview?.projectPath === projectPath ? page.overview : null;
    const rows = answered ? worktreesView(answered, page.filter) : null;
    const start = page.worktreeStart;
    const clean = page.worktreeClean;
    const cleanable = cleanableWorktrees(page.overview, projectPath).length;

    return (
        <section className="pp-section pp-worktrees" aria-labelledby="pp-worktrees-heading">
            <div className="pp-section-head">
                <h2 id="pp-worktrees-heading">Worktrees</h2>
                {answered && <span className="pp-count">{answered.worktrees.length}</span>}
                {cleanable > 0 && (
                    <button
                        type="button"
                        className="pp-link"
                        disabled={clean?.phase === 'cleaning'}
                        onClick={() => {
                            void cleanWorktrees(projectPath);
                        }}>
                        {clean?.phase === 'cleaning' ? 'Cleaning…' : `Clean ${cleanable}`}
                    </button>
                )}
            </div>
            <div className="pp-card" aria-busy={!rows}>
                {!rows && <SectionSkeleton label="Loading worktrees" rows={2} />}
                {rows && rows.length === 0 && <div className="pp-quiet">No worktree here matches.</div>}
                {rows?.map(({worktree, title, meta, running, startable}) => {
                    const id = cursorId.worktree(worktree.path);
                    const mine = start?.path === worktree.path ? start : null;
                    const refused =
                        clean?.phase === 'failed'
                            ? clean.failed.find((failure) => failure.path === worktree.path)
                            : undefined;
                    return (
                        <div
                            key={id}
                            className={
                                'pp-row pp-worktree' +
                                (worktree.merged ? ' is-merged' : '') +
                                (page.cursor === id ? ' is-cursor' : '')
                            }
                            data-cursor-id={id}
                            title={worktree.path}>
                            <svg
                                className="pp-worktree-icon"
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                aria-hidden="true">
                                <circle cx="6" cy="6" r="2.5" />
                                <circle cx="6" cy="18" r="2.5" />
                                <circle cx="18" cy="8" r="2.5" />
                                <path d="M6 8.5v7M18 10.5c0 4-6 3-11 5.5" />
                            </svg>
                            <span className="pp-row-text">
                                <span className="pp-row-title pp-mono pp-worktree-branch">{title}</span>
                                <span className="pp-row-meta">{meta}</span>
                            </span>
                            {running && (
                                <span
                                    className="pp-dot is-running pp-worktree-dot"
                                    role="img"
                                    aria-label="A session is running here"
                                />
                            )}
                            {mine?.phase === 'failed' && (
                                <span className="pp-start-failed" title={mine.reason}>
                                    Could not start
                                </span>
                            )}
                            {refused && (
                                <span className="pp-start-failed" title={refused.reason}>
                                    Could not remove
                                </span>
                            )}
                            {startable && (
                                <button
                                    type="button"
                                    className={'pp-start' + (mine?.phase === 'starting' ? ' is-starting' : '')}
                                    disabled={mine?.phase === 'starting'}
                                    onClick={() => {
                                        void startWorktreeSession(projectPath, worktree.path);
                                    }}>
                                    {mine?.phase === 'starting' ? 'Starting…' : 'Start session'}
                                </button>
                            )}
                        </div>
                    );
                })}
            </div>
        </section>
    );
}
