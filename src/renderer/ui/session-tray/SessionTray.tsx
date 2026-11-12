/**
 * The session tray (#343, epic #338): session tools that drop over the top of
 * the terminal when the bar above it, or the top of the terminal, is hovered.
 *
 * It lies over `#terminal-area` from a zero-height host under the header, so
 * the terminal below never moves and xterm is never refitted for it. Hovering
 * the bar or the tray drives the state machine in `session-tray-slice`; this
 * sets the one timer it asks for, marks the bar (the mint edge while the
 * pointer rests on it), and asks main for the session's prompts, links,
 * stats and editor each time the tray opens.
 *
 * Holding ⌘ on its own for 150 ms shows it too, so the saved prompts' ⌘1–9
 * can be read; letting go hides it.
 *
 * The keyboard: the bar's "hover for tools" button (and Tab on it) opens the
 * tray and moves into it; focus landing anywhere in it opens it; Esc closes it
 * and goes back to the bar. Keyboard focus inside keeps it up when the pointer
 * wanders off.
 */
import {useCallback, useEffect, useRef, useState} from 'react';
import type {JSX} from 'react';
import {dispatch} from '../../state/app-store';
import {shallowEqual} from '../../state/store';
import {sessionMap} from '../../state/session-store';
import {canBringBackSession, canHandOffSession} from '../../state/session-list-layout';
import {isVmCopyIn, isVmProjectIn} from '../../state/agent-host-slice';
import {openSessionBringBack} from '../dialogs/session-bring-back-actions';
import {sessionStatsIn, trayIsOpen} from '../../state/session-tray-slice';
import {useStore} from '../use-store';
import {stopSessionOnScreen} from '../terminal/actions';
import {archiveActiveSession} from '../../features/sessions/sidebar-keyboard';
import {openTaskTab} from '../session-task/actions';
import {loadSavedPrompts} from './saved-prompts';
import {factsFor, loadSessionLinks, loadSessionStats, projectOf, sendTrayPrompt} from './actions';
import {openSavedPromptsSettings} from '../settings/open-saved-prompts';
import {focusTray, focusTrayHint} from './focus';
import {trayLinks} from './tray-view';
import {inHeaderBox, inTerminalTopZone} from './hover-zone';
import {SessionTrayContent} from './SessionTrayContent';
import type {SessionTrayActions} from './SessionTrayContent';
import type {ResolvedSavedPrompt} from '../../../domain/settings/saved-prompts';
import type {SessionLink} from '../../../domain/session/links';
import type {WorkspaceEditorInfo} from '../../../domain/workspace/model';
import {openLink as followLink} from '../pr-view/actions';

/** What the tray asked main for, and whose it is. */
interface TrayData {
    sessionId: string | null;
    prompts: readonly ResolvedSavedPrompt[];
    links: readonly SessionLink[];
    editor: WorkspaceEditorInfo | null;
}

const EMPTY: TrayData = {sessionId: null, prompts: [], links: [], editor: null};

/** How long Copy session id says it copied. */
const COPIED_MS = 1200;

export function SessionTray(): JSX.Element | null {
    const {sessionId, phase, deadline, sent, stats, running, hosts, kept, isVm, isCopy} = useStore((state) => {
        const id = state.terminal.onScreen;
        const page = id ? state.pages.bySession[id] : undefined;
        const path = id ? sessionMap.get(id)?.projectPath : undefined;
        return {
            sessionId: id,
            phase: state.sessionTray.phase,
            deadline: state.sessionTray.deadline,
            sent: state.sessionTray.sent,
            stats: sessionStatsIn(state.sessionTray, id),
            running: !!id && state.view.activePtyIds.has(id),
            hosts: state.handoff.hosts,
            kept: page ?? null,
            isVm: isVmProjectIn(state.agentHost, path),
            isCopy: isVmCopyIn(state.agentHost, path),
        };
    }, shallowEqual);
    const open = trayIsOpen(phase);
    const shown = phase !== 'closed';

    const section = useRef<HTMLElement | null>(null);
    const holding = useRef(false);
    const [data, setData] = useState<TrayData>(EMPTY);
    const [copied, setCopied] = useState(false);

    // The one timer the state machine asks for.
    useEffect(() => {
        if (deadline === null) return;
        const timer = window.setTimeout(
            () => dispatch({type: 'trayTimerFired', deadline}),
            Math.max(0, deadline - Date.now()),
        );
        return () => window.clearTimeout(timer);
    }, [deadline]);

    const leave = useCallback(() => {
        // The host menu is up, or the keyboard is in the tray: the pointer wandering off does not close it.
        if (holding.current || keyboardInside(section.current)) return;
        dispatch({type: 'trayPointerLeft', at: Date.now()});
    }, []);

    // Hovering the bar, the tray, or the top of the terminal under them counts as
    // hovering the tray; the bar's edge glows while it does. One tracker over the
    // whole terminal area, so moving between those parts is not a leave.
    useEffect(() => {
        const area = document.getElementById('terminal-area');
        const header = document.getElementById('terminal-header');
        const terminals = document.getElementById('terminals');
        if (!area || !header || !terminals) return;
        let inside = false;
        const track = (e: PointerEvent): void => {
            const target = e.target as Element | null;
            const now =
                header.style.display !== 'none' &&
                (header.contains(target) ||
                    // The terminal's box overlaps the bar's bottom edge: that is still the bar.
                    (terminals.contains(target) && inHeaderBox(e.clientX, e.clientY, header.getBoundingClientRect())) ||
                    !!target?.closest('.session-tray-frame') ||
                    // Only on the terminal itself (its text, or the padding around it), not a
                    // card or page laid over it, nor on a link in it (xterm marks one under the
                    // pointer), which the tray would cover before it is clicked; and a drag
                    // (selecting text) never opens it.
                    (!!target &&
                        (target.classList.contains('terminal-container') || !!target.closest('.xterm')) &&
                        !target.closest('.xterm-cursor-pointer') &&
                        (inside || e.buttons === 0) &&
                        inTerminalTopZone(e.clientX, e.clientY, terminals.getBoundingClientRect())));
            if (now === inside) return;
            inside = now;
            if (now) dispatch({type: 'trayPointerEntered', at: Date.now()});
            else leave();
        };
        const out = (): void => {
            if (!inside) return;
            inside = false;
            leave();
        };
        area.addEventListener('pointermove', track);
        area.addEventListener('pointerover', track);
        area.addEventListener('pointerleave', out);
        return () => {
            area.removeEventListener('pointermove', track);
            area.removeEventListener('pointerover', track);
            area.removeEventListener('pointerleave', out);
        };
    }, [leave]);

    useEffect(() => {
        const header = document.getElementById('terminal-header');
        if (!header) return;
        const keydown = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') {
                dispatch({type: 'trayClosed'});
                return;
            }
            // Tab from the bar's tools button goes into the tray, opening it.
            if (
                e.key === 'Tab' &&
                !e.shiftKey &&
                (e.target as HTMLElement | null)?.id === 'terminal-header-tray-hint'
            ) {
                e.preventDefault();
                dispatch({type: 'trayOpened'});
                focusTray();
            }
        };
        header.addEventListener('keydown', keydown);
        return () => header.removeEventListener('keydown', keydown);
    }, []);

    // ⌘ held on its own shows the tray, so its shortcuts (⌘1–9) can be read;
    // letting go hides it again. Listened for on the window, before xterm.
    useEffect(() => {
        if (!sessionId) return;
        const down = (e: KeyboardEvent): void => {
            if (e.key !== 'Meta') {
                if (e.metaKey) dispatch({type: 'trayKeyChorded'});
                return;
            }
            if (e.repeat || e.shiftKey || e.altKey || e.ctrlKey) return;
            if (document.getElementById('terminal-header')?.style.display === 'none') return;
            dispatch({type: 'trayKeyHeld', at: Date.now()});
        };
        const up = (e: KeyboardEvent): void => {
            if (e.key === 'Meta') dispatch({type: 'trayKeyReleased'});
        };
        // ⌘Tab away: the key-up goes to another app.
        const blur = (): void => dispatch({type: 'trayKeyReleased'});
        window.addEventListener('keydown', down, true);
        window.addEventListener('keyup', up, true);
        window.addEventListener('blur', blur);
        return () => {
            window.removeEventListener('keydown', down, true);
            window.removeEventListener('keyup', up, true);
            window.removeEventListener('blur', blur);
        };
    }, [sessionId]);

    useEffect(() => {
        const header = document.getElementById('terminal-header');
        header?.classList.toggle('is-tray-intent', phase === 'intent');
        header?.classList.toggle('is-tray-open', open);
    }, [phase, open]);

    // Prompts as soon as the session is on screen, so the first hover has them;
    // links, stats and the editor are asked again on every open.
    useEffect(() => {
        if (!sessionId) return;
        let live = true;
        const update = (part: Partial<TrayData>): void => {
            if (live) setData((now) => ({...(now.sessionId === sessionId ? now : {...EMPTY, sessionId}), ...part}));
        };
        void loadSavedPrompts(projectOf(sessionId))
            .catch(() => [])
            .then((prompts) => update({prompts}));
        if (shown) {
            void loadSessionLinks(sessionId).then((links) => update({links}));
            void loadSessionStats(sessionId);
            void window.api
                .workspaceEditor({sessionId})
                .catch((): WorkspaceEditorInfo => ({available: false, reason: 'Could not tell'}))
                .then((editor) => update({editor}));
        }
        return () => {
            live = false;
        };
    }, [sessionId, shown]);

    useEffect(() => {
        if (!copied) return;
        const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
        return () => window.clearTimeout(timer);
    }, [copied]);

    if (!sessionId) return null;
    const mine = data.sessionId === sessionId ? data : {...EMPTY, sessionId};
    const row = sessionMap.get(sessionId);
    const handOffHosts = row && hosts && canHandOffSession(row, hosts.length) ? hosts : null;
    const bringBack = !!row && canBringBackSession(row, {vm: isVm, copy: isCopy});
    const close = (): void => dispatch({type: 'trayClosed'});

    const actions: SessionTrayActions = {
        sendPrompt: (prompt) => {
            sendTrayPrompt(sessionId, prompt, factsFor(sessionId, mine.links, stats?.branch ?? null));
        },
        editPrompts: () => {
            close();
            void openSavedPromptsSettings();
        },
        openLink: (link) => {
            close();
            if (link.kind === 'page') dispatch({type: 'pageReopened', sessionId});
            else if (link.kind === 'task') void openTaskTab(sessionId);
            else followLink(link.url);
        },
        openInEditor: () => void window.api.openInEditor({sessionId}),
        revealInFinder: () => void window.api.revealInFinder({sessionId}),
        shellHere: () => void window.api.shellHere({sessionId}),
        copySessionId: () => {
            void window.api.writeClipboard(sessionId);
            setCopied(true);
        },
        archive: () => {
            close();
            archiveActiveSession();
        },
        stop: () => {
            close();
            stopSessionOnScreen();
        },
        handOffMenu: (menuOpen) => {
            holding.current = menuOpen;
            if (!menuOpen) close();
        },
        handOffClicked: close,
        bringBack: () => {
            close();
            void openSessionBringBack(sessionId);
        },
    };

    return (
        <div
            ref={(el) => {
                section.current = el?.querySelector('section') ?? null;
            }}
            className="session-tray-frame"
            onFocus={() => {
                if (!open) dispatch({type: 'trayOpened'});
            }}
            onBlur={(e) => {
                const to = e.relatedTarget as Node | null;
                // Switching apps is not leaving the tray; nor is the host menu.
                if (!document.hasFocus() || holding.current) return;
                if (to && (e.currentTarget.contains(to) || document.getElementById('terminal-header')?.contains(to)))
                    return;
                close();
            }}
            onKeyDown={(e) => {
                if (e.key !== 'Escape') return;
                e.stopPropagation();
                close();
                focusTrayHint();
            }}>
            <SessionTrayContent
                sessionId={sessionId}
                open={open}
                sent={sent}
                prompts={mine.prompts}
                links={trayLinks(mine.links, kept)}
                stats={stats}
                editor={mine.editor}
                handOffHosts={handOffHosts}
                bringBack={bringBack}
                running={running}
                copied={copied}
                now={Date.now()}
                actions={actions}
            />
        </div>
    );
}

/** Whether the keyboard (not a click) has put the focus inside the tray. */
function keyboardInside(section: HTMLElement | null): boolean {
    const active = document.activeElement;
    return !!section && !!active && section.contains(active) && active.matches(':focus-visible');
}
