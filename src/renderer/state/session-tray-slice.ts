/**
 * The session tray (#343, epic #338): whether the tray over the terminal is
 * up, and the session's stats the bar and the tray both read.
 *
 * The tray opens on hover intent and closes after a grace, as a small state
 * machine (the design's "Motion · timings"):
 *
 * - closed → pointer on the bar → `intent`; 50 ms later → `open`. Leaving
 *   during intent goes straight back to `closed`: crossing the bar on the way
 *   elsewhere never opens it.
 * - open → pointer leaves bar and tray → `grace`; 250 ms later → `closed`.
 *   Coming back during the grace keeps it open, with no replay.
 * - a prompt sent (a click, or ⌘1–9 even while closed) → `sent`: the row
 *   flashes "Sent ✓" for 450 ms, then the tray closes without a grace. The
 *   pointer does not move it meanwhile.
 * - the keyboard (Tab into it, the bar's hint) opens it at once; Esc closes it.
 *
 * Pure: the time comes in on the events (`at`), and a timer firing names the
 * deadline it was set for, so a timer left over from a state since left
 * changes nothing. The component sets the one timer `deadline` asks for.
 */
import type {SessionStats} from '../../domain/session/stats';
import type {RendererEvent} from './events';

/** How long the pointer rests on the bar before the tray opens. */
export const TRAY_INTENT_MS = 50;
/** How long the tray stays after the pointer leaves, so a slip does not close it. */
export const TRAY_GRACE_MS = 250;
/** How long a sent prompt's row says "Sent ✓" before the tray closes. */
export const TRAY_SENT_MS = 450;

export type TrayPhase = 'closed' | 'intent' | 'open' | 'grace' | 'sent';

export type SessionTrayEvent =
    /** The pointer came onto the bar or the tray. */
    | {type: 'trayPointerEntered'; at: number}
    /** The pointer left the bar or the tray. */
    | {type: 'trayPointerLeft'; at: number}
    /** The timer set for `deadline` ran out. */
    | {type: 'trayTimerFired'; deadline: number}
    /** The keyboard opened it (Tab into it, the bar's hint): at once, no intent wait. */
    | {type: 'trayOpened'}
    /** Esc, focus leaving it, or an action that takes the user elsewhere. */
    | {type: 'trayClosed'}
    /** A saved prompt was typed into the session (a click or ⌘1–9). */
    | {type: 'trayPromptSent'; promptId: string; at: number}
    /** The session's stats came back (`getSessionStats`). */
    | {type: 'sessionStatsLoaded'; sessionId: string; stats: SessionStats};

export interface SessionTrayState {
    readonly phase: TrayPhase;
    /** When the current phase's timer runs out (epoch ms); null when none runs. */
    readonly deadline: number | null;
    /** The prompt flashing "Sent ✓"; kept through the close so the label does not jump while the tray clips up. */
    readonly sent: string | null;
    /** The last stats asked for, and whose they are. */
    readonly stats: {readonly sessionId: string; readonly stats: SessionStats} | null;
}

export const initialSessionTrayState: SessionTrayState = {phase: 'closed', deadline: null, sent: null, stats: null};

/** Whether the tray is up (or on its way down after a grace or a send). */
export function trayIsOpen(phase: TrayPhase): boolean {
    return phase === 'open' || phase === 'grace' || phase === 'sent';
}

export function sessionTrayReducer(state: SessionTrayState, event: RendererEvent): SessionTrayState {
    switch (event.type) {
        case 'trayPointerEntered':
            switch (state.phase) {
                case 'closed':
                    return {...state, phase: 'intent', deadline: event.at + TRAY_INTENT_MS, sent: null};
                case 'grace':
                    return {...state, phase: 'open', deadline: null};
                default:
                    return state;
            }

        case 'trayPointerLeft':
            switch (state.phase) {
                case 'intent':
                    return {...state, phase: 'closed', deadline: null};
                case 'open':
                    return {...state, phase: 'grace', deadline: event.at + TRAY_GRACE_MS};
                default:
                    return state;
            }

        case 'trayTimerFired':
            if (event.deadline !== state.deadline) return state;
            switch (state.phase) {
                case 'intent':
                    return {...state, phase: 'open', deadline: null};
                case 'grace':
                case 'sent':
                    return {...state, phase: 'closed', deadline: null};
                default:
                    return state;
            }

        case 'trayOpened':
            if (state.phase === 'open' || state.phase === 'sent') return state;
            return {...state, phase: 'open', deadline: null, sent: null};

        case 'trayClosed':
            return state.phase === 'closed' ? state : {...state, phase: 'closed', deadline: null};

        case 'trayPromptSent':
            return {...state, phase: 'sent', deadline: event.at + TRAY_SENT_MS, sent: event.promptId};

        // Another session on screen, or none: its tray goes with it.
        case 'sessionShown':
        case 'activeSessionChanged':
            return state.phase === 'closed' ? state : {...state, phase: 'closed', deadline: null};

        case 'sessionStatsLoaded':
            return {...state, stats: {sessionId: event.sessionId, stats: event.stats}};

        default:
            return state;
    }
}

/** A re-keyed session keeps its stats; see `rekeyState` in `root`. */
export function rekeySessionTray(state: SessionTrayState, oldId: string, newId: string): SessionTrayState {
    if (state.stats?.sessionId !== oldId) return state;
    return {...state, stats: {...state.stats, sessionId: newId}};
}

/** The stats of `sessionId`, once asked for; null before, or when they are another session's. */
export function sessionStatsIn(state: SessionTrayState, sessionId: string | null): SessionStats | null {
    return sessionId && state.stats?.sessionId === sessionId ? state.stats.stats : null;
}
