/**
 * The session tray's markup (#343, design "Tinted cards · sidebar look"):
 * four tinted groups side by side, from what it is given.
 *
 * - Ask: the saved prompts with their ⌘ keys, and Edit (the Settings editor).
 * - Links: the session's PRs, issues, artifacts, latest page and task.
 * - Workspace: Editor, Finder, Shell here, Hand off….
 * - Session: context used with its meter, shell · running time · messages,
 *   Copy session id, Archive and Stop.
 *
 * The tray is always the same height: a group with more rows than fit
 * scrolls inside its card (`.tray-card-body`) instead of stretching the tray.
 *
 * Kept apart from the store so a test can draw it; `SessionTray` feeds it.
 */
import type {CSSProperties, JSX, MouseEvent} from 'react';
import type {ResolvedSavedPrompt} from '../../../domain/settings/saved-prompts';
import type {SessionLink} from '../../../domain/session/links';
import type {SessionStats} from '../../../domain/session/stats';
import type {WorkspaceEditorInfo} from '../../../domain/workspace/model';
import type {HandoffHost} from '../../../application/services/project-handoff';
import {HandOffSessionButton} from '../session-handoff/HandOffSessionButton';
import {ChipDot} from '../session-list/RowMeta';
import {contextPercent, linkMeta, sessionMetaLine, type LinkDot, type TrayLink} from './tray-view';
import {SESSION_TRAY_ID} from './focus';

/** What the tray's controls do. */
export interface SessionTrayActions {
    sendPrompt(prompt: ResolvedSavedPrompt): void;
    editPrompts(): void;
    openLink(link: SessionLink): void;
    openInEditor(): void;
    revealInFinder(): void;
    shellHere(): void;
    copySessionId(): void;
    archive(): void;
    stop(): void;
    /** The Hand off host menu opened or closed: the tray stays while it is up. */
    handOffMenu(open: boolean): void;
    /** Hand off… opened its dialog straight away (one host). */
    handOffClicked(): void;
}

export interface SessionTrayContentProps {
    sessionId: string;
    /** Up (open, in its grace, or flashing a send). */
    open: boolean;
    /** The prompt flashing "Sent ✓". */
    sent: string | null;
    prompts: readonly ResolvedSavedPrompt[];
    links: readonly TrayLink[];
    stats: SessionStats | null;
    /** The IDE Editor opens; null until asked. */
    editor: WorkspaceEditorInfo | null;
    /** The VM hosts Hand off… can go to; null when the session cannot be handed off. */
    handOffHosts: readonly HandoffHost[] | null;
    running: boolean;
    /** Copy session id was just pressed. */
    copied: boolean;
    now: number;
    actions: SessionTrayActions;
}

export function SessionTrayContent(props: SessionTrayContentProps): JSX.Element {
    return (
        <section
            id={SESSION_TRAY_ID}
            className={'session-tray' + (props.open ? ' is-open' : '')}
            aria-label="Session tools">
            <AskGroup {...props} />
            <LinksGroup {...props} />
            <WorkspaceGroup {...props} />
            <SessionGroup {...props} />
        </section>
    );
}

function AskGroup({prompts, sent, actions}: SessionTrayContentProps): JSX.Element {
    return (
        <div className="tray-card tray-ask" role="group" aria-labelledby="tray-ask-label" style={order(0)}>
            <div className="tray-label" id="tray-ask-label">
                Ask
                <button
                    type="button"
                    className="tray-edit"
                    aria-label="Edit saved prompts"
                    onClick={actions.editPrompts}>
                    Edit
                </button>
            </div>
            <div className="tray-card-body">
                {prompts.length === 0 && <p className="tray-empty">No saved prompts yet</p>}
                {prompts.map((prompt) => {
                    const isSent = sent === prompt.id;
                    return (
                        <button
                            key={prompt.scope + ':' + prompt.id}
                            type="button"
                            className={'tray-row' + (isSent ? ' is-sent' : '')}
                            title={prompt.text}
                            aria-label={(prompt.mode === 'send' ? 'Send: ' : 'Type: ') + prompt.label}
                            onClick={() => actions.sendPrompt(prompt)}>
                            <span className="tray-row-text">{isSent ? 'Sent ✓' : prompt.label}</span>
                            {prompt.key !== null && <span className="tray-key">{'⌘' + prompt.key}</span>}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

function LinksGroup({links, now, actions}: SessionTrayContentProps): JSX.Element {
    return (
        <div className="tray-card tray-links" role="group" aria-labelledby="tray-links-label" style={order(1)}>
            <div className="tray-label" id="tray-links-label">
                Links
            </div>
            <div className="tray-card-body">
                {links.length === 0 && <p className="tray-empty">Nothing yet</p>}
                {links.map(({link, opens}) => {
                    const meta = linkMeta(link, now);
                    const inside = (
                        <>
                            <span className="tray-link-title">{link.title}</span>
                            <span className="tray-link-meta">
                                <span className="tray-chip">
                                    <LinkChipDot dot={meta.dot} />
                                    {meta.chip}
                                </span>
                                {meta.text}
                            </span>
                        </>
                    );
                    const url = linkUrl(link);
                    if (url) {
                        return (
                            <a
                                key={link.key}
                                className="tray-link"
                                href={url}
                                title={url}
                                onClick={(e: MouseEvent<HTMLAnchorElement>) => {
                                    e.preventDefault();
                                    actions.openLink(link);
                                }}>
                                {inside}
                            </a>
                        );
                    }
                    return (
                        <button
                            key={link.key}
                            type="button"
                            className="tray-link"
                            disabled={!opens}
                            title={
                                opens
                                    ? linkTitle(link)
                                    : 'Shown before Switchboard restarted, so it cannot be shown again'
                            }
                            onClick={() => actions.openLink(link)}>
                            {inside}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

/** Where a link goes in the browser; null for the page and a task without its Notion page, which open here. */
function linkUrl(link: SessionLink): string | null {
    switch (link.kind) {
        case 'pr':
        case 'issue':
        case 'artifact':
            return link.url;
        default:
            return null;
    }
}

function linkTitle(link: SessionLink): string {
    return link.kind === 'page'
        ? `Show “${link.title}” again`
        : link.kind === 'task'
          ? 'Open the Task tab'
          : link.title;
}

/** A PR's dot as the sidebar draws it; the other kinds a dot in their colour. */
function LinkChipDot({dot}: {dot: LinkDot | null}): JSX.Element | null {
    if (dot === null) return null;
    if (dot === 'merged' || dot === 'green' || dot === 'amber' || dot === 'red') return <ChipDot dot={dot} />;
    return <span className={'tray-dot is-' + dot} aria-hidden="true" />;
}

function WorkspaceGroup({editor, handOffHosts, sessionId, actions}: SessionTrayContentProps): JSX.Element {
    const available = editor?.available === true;
    const why = editor && !editor.available ? editor.reason : undefined;
    const app = editor?.available ? editor.app : null;
    return (
        <div className="tray-card tray-workspace" role="group" aria-labelledby="tray-ws-label" style={order(2)}>
            <div className="tray-label" id="tray-ws-label">
                Workspace
            </div>
            <div className="tray-card-body">
                <button
                    type="button"
                    className="tray-row"
                    disabled={!available}
                    title={why}
                    aria-label={app ? 'Open in ' + app : 'Open in editor'}
                    onClick={actions.openInEditor}>
                    <Icon d="m6 4.5-3.5 3.5L6 11.5M10 4.5l3.5 3.5-3.5 3.5" />
                    {app ?? 'Editor'}
                </button>
                <button
                    type="button"
                    className="tray-row"
                    disabled={!available}
                    title={why}
                    aria-label="Reveal in Finder"
                    onClick={actions.revealInFinder}>
                    <Icon d="M2 4.5h4l1.5 1.5H14v6.5H2z" />
                    Finder
                </button>
                <button
                    type="button"
                    className="tray-row"
                    disabled={!available}
                    title={why}
                    aria-label="Open a shell here"
                    onClick={actions.shellHere}>
                    <Icon d="m5 7 2 1.5L5 10M8.5 10.5H11" rect={{x: 2, y: 3, width: 12, height: 10, rx: 2}} />
                    Shell here
                </button>
                {handOffHosts && (
                    // The button keeps its click to itself; with one host that click opens the dialog at once.
                    <div
                        className="tray-handoff"
                        onClickCapture={() => {
                            if (handOffHosts.length === 1) actions.handOffClicked();
                        }}>
                        <HandOffSessionButton
                            sessionId={sessionId}
                            hosts={handOffHosts}
                            className="tray-row"
                            onMenu={actions.handOffMenu}
                            html={{__html: HAND_OFF_HTML}}
                        />
                    </div>
                )}
            </div>
        </div>
    );
}

const HAND_OFF_HTML =
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="12" height="8" rx="1.5"></rect><path d="M5.5 13.5h5M8 11v2.5"></path></svg>Hand off…';

function SessionGroup({stats, running, copied, now, actions}: SessionTrayContentProps): JSX.Element {
    const percent = contextPercent(stats?.contextUsed);
    const meter = {'--tray-context': (percent ?? 0) + '%'} as CSSProperties;
    return (
        <div className="tray-card tray-session" role="group" aria-labelledby="tray-session-label" style={order(3)}>
            <div className="tray-label" id="tray-session-label">
                Session
            </div>
            <div className="tray-stats">
                <div className="tray-context">
                    <span className="tray-context-value">{percent === null ? '—' : percent + '%'}</span>
                    <span className="tray-context-label">context</span>
                </div>
                <span
                    className="tray-meter"
                    role="meter"
                    aria-label="Context used"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent ?? 0}
                    style={meter}>
                    <span className="tray-meter-fill" />
                </span>
                <span className="tray-meta">{sessionMetaLine(stats, now)}</span>
            </div>
            <div className="tray-icons">
                <button
                    type="button"
                    className="tray-icon"
                    aria-label={copied ? 'Session id copied' : 'Copy session id'}
                    title={copied ? 'Copied' : 'Copy session id'}
                    onClick={actions.copySessionId}>
                    <Icon d="M3 10.5V4a1 1 0 0 1 1-1h6.5" rect={{x: 5, y: 5, width: 8, height: 8, rx: 1.5}} />
                </button>
                <button
                    type="button"
                    className="tray-icon"
                    aria-label="Archive"
                    title="Archive · ⌘E"
                    onClick={actions.archive}>
                    <Icon d="M3 6v7h10V6M6.5 9h3" rect={{x: 2, y: 3, width: 12, height: 3, rx: 1}} />
                </button>
                <button
                    type="button"
                    className="tray-icon tray-stop"
                    aria-label="Stop session"
                    title="Stop process"
                    disabled={!running}
                    onClick={actions.stop}>
                    <svg width="13" height="13" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
                        <rect x="2" y="2" width="8" height="8" rx="1" />
                    </svg>
                </button>
            </div>
        </div>
    );
}

/** A group's place in the open stagger (`--i` in the design). */
function order(i: number): CSSProperties {
    return {'--i': i} as CSSProperties;
}

function Icon({
    d,
    rect,
}: {
    d: string;
    rect?: {x: number; y: number; width: number; height: number; rx: number};
}): JSX.Element {
    return (
        <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true">
            {rect && <rect {...rect} />}
            <path d={d} />
        </svg>
    );
}
