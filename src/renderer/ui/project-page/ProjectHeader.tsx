/**
 * The project page's header (#173): Close, the project's name and where it
 * is, and the GitHub, Settings and New session buttons.
 *
 * The subline has the GitHub repository and the current branch, as the
 * project overview (#172) answers them (#174), then the path, then how fresh
 * GitHub's part of the page is, and "Updating…" while what shows is the
 * answer stored from an earlier visit, with main asked again. A remote
 * project names its host (#175). An agentless one, which has no GitHub, shows
 * no GitHub button; nor does a project the overview answers has no GitHub
 * remote. A VM project (#276 stage 4) has its VM badge and the GitHub button.
 * A project on a registered VM (#307) says which, "On <VM> · Manage in
 * Settings", in place of the host's address.
 *
 * Hand-off (#276 stage 2): a local project offers Hand off to… once there is
 * a VM host, and a copy on a VM says which local project it is a copy of.
 */
import type {JSX} from 'react';
import {projectLabel} from '../../features/sessions/project-label';
import {useStore} from '../use-store';
import {formatDate} from '../../lib/format';
import {opensGitHub, remoteHost} from './page-state';
import {remoteBadge} from '../../features/sessions/remote-badge';
import {isVmProjectIn} from '../../state/agent-host-slice';
import {CopyOriginLink, HandOffButton} from './HandoffSections';
import {useHostLink, VmLink} from './VmLink';
import {closeProject, isRemoteProject, openProjectOnGitHub, openProjectSettings, startProjectSession} from './actions';

/** The repository on GitHub, as a link, and the branch the main checkout is on. */
function HeaderFacts({projectPath}: {projectPath: string}): JSX.Element | null {
    const overview = useStore((state) =>
        state.projectPage.overview?.projectPath === projectPath ? state.projectPage.overview : null,
    );
    if (!overview) return null;
    const branch = overview.worktrees.find((worktree) => worktree.main)?.branch ?? null;
    return (
        <>
            {overview.repository && (
                <button type="button" className="pp-repo" onClick={() => openProjectOnGitHub(projectPath)}>
                    {overview.repository} ↗
                </button>
            )}
            {branch && (
                <span className="pp-branch">
                    <svg
                        width="12"
                        height="12"
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
                    {branch}
                </span>
            )}
        </>
    );
}

/** "Updated 2m ago": when GitHub's part of the page was read; "· Updating…" while it is the stored answer. */
function UpdatedAt({projectPath}: {projectPath: string}): JSX.Element | null {
    const fetchedAt = useStore((state) => {
        const overview = state.projectPage.overview;
        return overview?.projectPath === projectPath && overview.github?.ok ? overview.github.fetchedAt : null;
    });
    const updating = useStore(
        (state) =>
            state.projectPage.overview?.projectPath === projectPath && state.projectPage.overviewFrom?.stored === true,
    );
    const now = useStore((state) => state.sessionList.now) || Date.now();
    if (fetchedAt === null && !updating) return null;
    return (
        <span className="pp-updated">
            {fetchedAt !== null && 'Updated ' + formatDate(new Date(fetchedAt), Math.max(now, fetchedAt))}
            {fetchedAt !== null && updating && ' · '}
            {updating && 'Updating…'}
        </span>
    );
}

/** VM (#276), as the Projects modal badges the project; an ssh project's header stays as it was. */
function HostBadge({projectPath}: {projectPath: string}): JSX.Element | null {
    const agent = useStore((state) => isVmProjectIn(state.agentHost, projectPath));
    const badge = remoteBadge({projectPath, remote: true, agent});
    if (!badge || !agent) return null;
    return (
        <span className="remote-badge is-vm pp-host-badge" title={badge.title}>
            {badge.label}
        </span>
    );
}

export function ProjectHeader({projectPath}: {projectPath: string}): JSX.Element {
    const remote = isRemoteProject(projectPath);
    const vm = useStore((state) => isVmProjectIn(state.agentHost, projectPath));
    const link = useHostLink(projectPath);
    // Until the first answer the button shows: most projects are on GitHub.
    const noGitHub = useStore(
        (state) =>
            state.projectPage.overview?.projectPath === projectPath && state.projectPage.overview.github === null,
    );
    return (
        <header className="sw-header pp-header">
            <div className="sw-header-row">
                <button
                    type="button"
                    className="sw-btn sw-back"
                    onClick={closeProject}
                    aria-label="Close project (Esc)">
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
                        <path d="M18 6 6 18M6 6l12 12" />
                    </svg>
                    Close <kbd className="sw-kbd">esc</kbd>
                </button>
                <div className="sw-heading">
                    <h1 className="sw-title pp-title">{projectLabel(projectPath)}</h1>
                    <div className="sw-subline pp-subline">
                        {remote && <CopyOriginLink projectPath={projectPath} />}
                        <HeaderFacts projectPath={projectPath} />
                        <span className="pp-path">{projectPath}</span>
                        <UpdatedAt projectPath={projectPath} />
                    </div>
                </div>
                <div className="pp-header-actions">
                    {remote && <HostBadge projectPath={projectPath} />}
                    {link?.kind === 'vm' ? (
                        <VmLink link={link} />
                    ) : (
                        remote && <span className="pp-host">{remoteHost(projectPath)}</span>
                    )}
                    {opensGitHub(projectPath, vm) && !noGitHub && (
                        <button type="button" className="sw-btn" onClick={() => openProjectOnGitHub(projectPath)}>
                            <svg
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                aria-hidden="true">
                                <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
                            </svg>
                            GitHub
                        </button>
                    )}
                    {!remote && <HandOffButton projectPath={projectPath} />}
                    <button type="button" className="sw-btn" onClick={() => openProjectSettings(projectPath)}>
                        <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            aria-hidden="true">
                            <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12" />
                            <circle cx="16" cy="6" r="2" />
                            <circle cx="10" cy="12" r="2" />
                            <circle cx="18" cy="18" r="2" />
                        </svg>
                        Settings
                    </button>
                    <button
                        type="button"
                        className="sw-btn is-primary"
                        onClick={() => startProjectSession(projectPath)}>
                        <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.4"
                            strokeLinecap="round"
                            aria-hidden="true">
                            <path d="M12 5v14M5 12h14" />
                        </svg>
                        New session
                    </button>
                </div>
            </div>
        </header>
    );
}
