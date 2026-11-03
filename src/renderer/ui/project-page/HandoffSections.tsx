/**
 * Project hand-off on the project page (#276 stage 2).
 *
 * - On a local project: Hand off to… in the header, once there is a VM host.
 *   With one host it opens the dialog; with several a small menu picks one.
 *   The On VMs section lists the project's copies, each a link to its page.
 * - On a copy: "Copy of <local project>" in the header, linking back, and the
 *   Copy section with Bring back and Remove copy. Bring back shows its
 *   progress, then the branch it checked out with a link to the local
 *   project. Remove copy lists the work only the copy has, offering Bring
 *   back first or Remove anyway; a clean copy is confirmed natively.
 *
 * What each part says is `handoff-view`; what it does is `handoff-actions`.
 */
import {useEffect, useRef, useState} from 'react';
import type {JSX, KeyboardEvent} from 'react';
import {useStore} from '../use-store';
import {bringBackIn, copiesIn, originIn, removalIn} from '../../state/handoff-slice';
import {
    bringBackView,
    copyLinks,
    dirtyView,
    handOffOpens,
    originLine,
    showsHandOff,
    UNREACHABLE_REMOVE,
} from './handoff-view';
import {
    bringBack,
    bringBackFirst,
    cancelRemoveCopy,
    loadCopyOrigin,
    loadHandoffHosts,
    loadProjectCopies,
    openCopy,
    openHandOffDialog,
    removeCopy,
    removeCopyAnyway,
} from './handoff-actions';
import {openProjectPage} from './actions';
import type {Capped} from './handoff-view';

/** Hand off to…, in a local project's header. */
export function HandOffButton({projectPath}: {projectPath: string}): JSX.Element | null {
    const hosts = useStore((state) => state.handoff.hosts);
    const [picking, setPicking] = useState(false);
    const menu = useRef<HTMLDivElement>(null);

    // The hosts are asked as the page opens: an install since may have added one.
    useEffect(() => {
        void loadHandoffHosts();
    }, [projectPath]);

    useEffect(() => {
        if (picking) menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    }, [picking]);

    if (!hosts || !showsHandOff(projectPath, hosts)) return null;

    const onClick = (): void => {
        const opens = handOffOpens(hosts);
        if (opens.kind === 'dialog') void openHandOffDialog(projectPath, opens.host);
        else setPicking((open) => !open);
    };

    const onMenuKey = (e: KeyboardEvent<HTMLDivElement>): void => {
        if (e.key === 'Escape') {
            // The menu's own Escape; the page's would close the page.
            e.preventDefault();
            e.stopPropagation();
            setPicking(false);
            return;
        }
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        e.stopPropagation();
        const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
        const at = items.indexOf(document.activeElement as HTMLElement);
        items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    };

    return (
        <div className="pp-handoff">
            <button
                type="button"
                className="sw-btn"
                aria-haspopup={hosts.length > 1 ? 'menu' : undefined}
                aria-expanded={hosts.length > 1 ? picking : undefined}
                onClick={onClick}>
                Hand off to…
            </button>
            {picking && (
                <div
                    ref={menu}
                    className="pp-handoff-menu"
                    role="menu"
                    aria-label="Hand off to"
                    onKeyDown={onMenuKey}
                    onBlur={(e) => {
                        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPicking(false);
                    }}>
                    {hosts.map((host) => (
                        <button
                            key={host.key}
                            type="button"
                            role="menuitem"
                            className="pp-handoff-item"
                            onClick={() => {
                                setPicking(false);
                                void openHandOffDialog(projectPath, host);
                            }}>
                            {host.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

/** On VMs: a local project's copies, each a link to its page with its host. */
export function CopiesSection({projectPath}: {projectPath: string}): JSX.Element | null {
    const copies = useStore((state) => copiesIn(state.handoff, projectPath));

    useEffect(() => {
        void loadProjectCopies(projectPath);
    }, [projectPath]);

    if (copies.length === 0) return null;
    return (
        <section className="pp-section pp-copies" aria-labelledby="pp-copies-heading">
            <div className="pp-section-head">
                <h2 id="pp-copies-heading">On VMs</h2>
                <span className="pp-count">{copies.length}</span>
            </div>
            <div className="pp-card">
                {copyLinks(copies).map((link) => (
                    <button
                        key={link.copyPath}
                        type="button"
                        className="pp-row pp-copy"
                        title={link.copyPath}
                        onClick={() => openCopy(link.copyPath)}>
                        <span className="pp-row-text">
                            <span className="pp-row-title">{link.title}</span>
                            <span className="pp-row-meta">{link.host}</span>
                        </span>
                        <span className="remote-badge is-vm">VM</span>
                    </button>
                ))}
            </div>
        </section>
    );
}

/** "Copy of <local project>", in a copy's header subline, linking back. */
export function CopyOriginLink({projectPath}: {projectPath: string}): JSX.Element | null {
    const origin = useStore((state) => originIn(state.handoff, projectPath));

    useEffect(() => {
        void loadCopyOrigin(projectPath);
    }, [projectPath]);

    if (!origin) return null;
    return (
        <button type="button" className="pp-repo pp-origin" title={origin} onClick={() => openProjectPage(origin)}>
            {originLine(origin)}
        </button>
    );
}

/** On a copy's page: Bring back and Remove copy. */
export function CopySection({projectPath}: {projectPath: string}): JSX.Element | null {
    const origin = useStore((state) => originIn(state.handoff, projectPath));
    const bringing = useStore((state) => bringBackIn(state.handoff, projectPath));
    const removal = useStore((state) => removalIn(state.handoff, projectPath));
    if (!origin) return null;

    const back = bringBackView(bringing);
    const busy = removal.phase === 'checking' || removal.phase === 'removing' || removal.phase === 'confirming';
    return (
        <section className="pp-section pp-copy-actions" aria-labelledby="pp-copy-heading">
            <div className="pp-section-head">
                <h2 id="pp-copy-heading">This copy</h2>
            </div>
            <div className="pp-card pp-message">
                <div className="pp-message-text">
                    Bring back checks the copy’s branch out in a new worktree of the local project.
                </div>
                {back.lines.length > 0 && (
                    <pre className="pp-agent-log" aria-live="polite">
                        {back.lines.join('\n')}
                    </pre>
                )}
                {back.error && (
                    <div className="pp-agent-error" role="alert">
                        {back.error}
                    </div>
                )}
                {bringing.phase === 'done' && (
                    <div className="pp-copy-done" role="status">
                        Checked out <code className="pp-mono">{bringing.branch}</code> in a new worktree.{' '}
                        <button
                            type="button"
                            className="pp-inline-link"
                            onClick={() => openProjectPage(bringing.worktree)}>
                            Open the local project
                        </button>
                    </div>
                )}
                {removal.phase === 'dirty' && <DirtyList copyPath={projectPath} />}
                {removal.phase === 'unreachable' && (
                    <div className="pp-agent-error" role="alert">
                        {UNREACHABLE_REMOVE}
                    </div>
                )}
                {removal.phase === 'failed' && (
                    <div className="pp-agent-error" role="alert">
                        {removal.error}
                    </div>
                )}
                {removal.phase !== 'dirty' && (
                    <div className="pp-message-actions">
                        <button
                            type="button"
                            className="sw-btn is-primary"
                            disabled={back.disabled || busy}
                            onClick={() => void bringBack(projectPath)}>
                            {back.label}
                        </button>
                        <button
                            type="button"
                            className="sw-btn is-warn"
                            disabled={back.disabled || busy}
                            onClick={() => void removeCopy(projectPath)}>
                            {removal.phase === 'checking'
                                ? 'Checking…'
                                : removal.phase === 'removing'
                                  ? 'Removing…'
                                  : 'Remove copy'}
                        </button>
                    </div>
                )}
            </div>
        </section>
    );
}

/** The work only the copy has, before it is removed. */
function DirtyList({copyPath}: {copyPath: string}): JSX.Element | null {
    const removal = useStore((state) => removalIn(state.handoff, copyPath));
    if (removal.phase !== 'dirty') return null;
    const view = dirtyView(removal.status);
    return (
        <div className="pp-copy-dirty" role="alert">
            <div className="pp-message-title">{view.heading}</div>
            {view.commitsTitle && <CappedList title={view.commitsTitle} items={view.commits} />}
            {view.pathsTitle && <CappedList title={view.pathsTitle} items={view.paths} mono />}
            <div className="pp-message-actions">
                <button type="button" className="sw-btn is-primary" onClick={() => void bringBackFirst(copyPath)}>
                    Bring back first
                </button>
                <button type="button" className="sw-btn is-warn" onClick={() => void removeCopyAnyway(copyPath)}>
                    Remove anyway
                </button>
                <button type="button" className="sw-btn" onClick={() => cancelRemoveCopy(copyPath)}>
                    Cancel
                </button>
            </div>
        </div>
    );
}

function CappedList({title, items, mono = false}: {title: string; items: Capped; mono?: boolean}): JSX.Element {
    return (
        <div className="pp-copy-list">
            <div className="pp-copy-list-title">{title}</div>
            <ul>
                {items.shown.map((item, index) => (
                    <li key={index} className={mono ? 'pp-mono' : undefined}>
                        {item}
                    </li>
                ))}
                {items.more && <li className="pp-copy-more">{items.more}</li>}
            </ul>
        </div>
    );
}
