/**
 * The open grilling rounds, as main last described them, and what the
 * grilling card is doing about each.
 *
 * Main owns a round and its draft answers (`GrillView`, pushed on every
 * change, fetched once at start); the Mac window and the phone edit the same
 * drafts. What is the window's own sits beside it, per session: the card's
 * working state for the round (`GrillCardUi`: place, open fields, folded
 * context, the banner, the last error) and the answers it has sent main but
 * not yet heard back about, which the card shows meanwhile.
 *
 * Everything is keyed by the session's current id and follows a re-key. A
 * round's working state is kept for as long as that round is the session's:
 * a different round starts clean, and a round closing drops it all.
 */
import {bannerSeenFor, withSeen} from '../features/grill/grill-banner';
import {freshUi, reviseUi, sameAnswer} from '../features/grill/grill-ui';
import {movedEntry, withEntry, withoutEntry} from './records';
import type {GrillCardUi, GrillField, InFlightAnswer} from '../features/grill/grill-ui';
import type {GrillView} from '../../domain/grill/model';
import type {IdRecord} from './records';
import type {RendererEvent} from './events';

export interface GrillState {
    /** sessionId → its open round. */
    readonly views: IdRecord<GrillView>;
    /** sessionId → the card's working state for that round. */
    readonly ui: IdRecord<GrillCardUi>;
    /** sessionId → the answers sent to main and not yet settled. */
    readonly inFlight: IdRecord<readonly InFlightAnswer[]>;
    /**
     * Round ids main said closed. The start-up fetch can resolve after a round
     * it returned was closed by an event, and must not bring it back.
     */
    readonly closed: IdRecord<true>;
}

export const initialGrillState: GrillState = {views: {}, ui: {}, inFlight: {}, closed: {}};

/** Where a working-state event applies: the session and the round it was made for. */
interface At {
    sessionId: string;
    roundId: string;
}

export type GrillEvent =
    /** The open rounds, fetched as the window starts. */
    | {type: 'grillLoaded'; views: readonly GrillView[]}
    /** A tab, a key or a Change on the review moved the card to `place`. */
    | ({type: 'grillNavigated'; place: number} & At)
    /** N, O or ? opened a field on the question at `place`. */
    | ({type: 'grillFieldOpened'; place: number; field: GrillField} & At)
    | ({type: 'grillFieldTyped'; place: number; text: string} & At)
    /** Esc, or the field was committed. */
    | ({type: 'grillFieldClosed'; place: number} & At)
    | ({type: 'grillContextToggled'; open: boolean} & At)
    | ({type: 'grillBannerDismissed'; revision: number} & At)
    /** The card showed the question at `place` during `revision`. */
    | ({type: 'grillSeen'; revision: number; place: number} & At)
    /** A call answered with an error to show, or the next one cleared it (null). */
    | ({type: 'grillError'; error: string | null} & At)
    /** An answer went to main; the card shows it until the call settles. */
    | {type: 'grillAnswerSent'; sessionId: string; entry: InFlightAnswer}
    /** Main answered the call numbered `seq`. */
    | {type: 'grillAnswerSettled'; sessionId: string; seq: number; ok: boolean};

export function grillReducer(state: GrillState, event: RendererEvent): GrillState {
    switch (event.type) {
        case 'grillLoaded': {
            let next = state;
            for (const view of event.views) {
                if (state.closed[view.roundId] || next.views[view.sessionId]) continue;
                next = putView(next, view.sessionId, view);
            }
            return next;
        }

        case 'grillChanged': {
            const {sessionId, view} = event.changed;
            if (view) return putView(state, sessionId, view);
            const was = state.views[sessionId];
            return {
                views: withoutEntry(state.views, sessionId),
                ui: withoutEntry(state.ui, sessionId),
                inFlight: withoutEntry(state.inFlight, sessionId),
                closed: was ? withEntry(state.closed, was.roundId, true) : state.closed,
            };
        }

        case 'grillNavigated':
            return withUi(state, event, (ui) => (ui.place === event.place ? ui : {...ui, place: event.place}));

        case 'grillFieldOpened':
            return withUi(state, event, (ui) => ({...ui, fields: {...ui.fields, [event.place]: event.field}}));

        case 'grillFieldTyped':
            return withUi(state, event, (ui) => {
                const field = ui.fields[event.place];
                if (!field || field.text === event.text) return ui;
                return {...ui, fields: {...ui.fields, [event.place]: {...field, text: event.text}}};
            });

        case 'grillFieldClosed':
            return withUi(state, event, (ui) => {
                if (!ui.fields[event.place]) return ui;
                const fields = {...ui.fields};
                delete fields[event.place];
                return {...ui, fields};
            });

        case 'grillContextToggled':
            return withUi(state, event, (ui) =>
                ui.contextOpen === event.open ? ui : {...ui, contextOpen: event.open},
            );

        case 'grillBannerDismissed':
            return withUi(state, event, (ui) => {
                const banner = bannerSeenFor(ui.banner, event.revision);
                return banner.dismissed ? ui : {...ui, banner: {...banner, dismissed: true}};
            });

        case 'grillSeen':
            return withUi(state, event, (ui) => {
                const before = bannerSeenFor(ui.banner, event.revision);
                const banner = withSeen(before, event.place);
                return banner === ui.banner ? ui : {...ui, banner};
            });

        case 'grillError':
            return withUi(state, event, (ui) => (ui.error === event.error ? ui : {...ui, error: event.error}));

        case 'grillAnswerSent': {
            const view = state.views[event.sessionId];
            if (!view || view.roundId !== event.entry.roundId) return state;
            const list = state.inFlight[event.sessionId] ?? [];
            return {...state, inFlight: withEntry(state.inFlight, event.sessionId, [...list, event.entry])};
        }

        case 'grillAnswerSettled': {
            const list = state.inFlight[event.sessionId];
            const entry = list?.find((e) => e.seq === event.seq);
            if (!list || !entry) return state;
            const view = state.views[event.sessionId];
            const shown = view?.questions[entry.place]?.answer ?? null;
            // Gone at once when it failed, or when main's view already shows it;
            // otherwise held until the next snapshot, which will.
            const drop = !event.ok || (view?.revision === entry.revision && sameAnswer(shown, entry.answer));
            const next = drop
                ? list.filter((e) => e !== entry)
                : list.map((e) => (e === entry ? {...e, settled: true} : e));
            return {...state, inFlight: putList(state.inFlight, event.sessionId, next)};
        }

        default:
            return state;
    }
}

/**
 * A new snapshot of a session's round. A different round starts the working
 * state over; a revision of the same one carries it across. Answers whose
 * calls settled are now in main's view, so they stop being laid over it.
 */
function putView(state: GrillState, sessionId: string, view: GrillView): GrillState {
    if (state.closed[view.roundId]) return state;
    const before = state.views[sessionId];
    let ui = state.ui;
    const mine = ui[sessionId];
    if (mine && mine.roundId !== view.roundId) ui = withoutEntry(ui, sessionId);
    else if (mine && before && before.roundId === view.roundId && before.revision !== view.revision)
        ui = withEntry(ui, sessionId, reviseUi(mine, before.questions, view.questions));

    let inFlight = state.inFlight;
    const list = inFlight[sessionId];
    if (list) {
        const live = list.filter((e) => e.roundId === view.roundId && !e.settled);
        if (live.length !== list.length) inFlight = putList(inFlight, sessionId, live);
    }
    return {...state, views: withEntry(state.views, sessionId, view), ui, inFlight};
}

function putList(
    record: IdRecord<readonly InFlightAnswer[]>,
    sessionId: string,
    list: readonly InFlightAnswer[],
): IdRecord<readonly InFlightAnswer[]> {
    return list.length ? withEntry(record, sessionId, list) : withoutEntry(record, sessionId);
}

/** Apply `change` to the session's working state for the round, starting it if need be. */
function withUi(state: GrillState, at: At, change: (ui: GrillCardUi) => GrillCardUi): GrillState {
    const view = state.views[at.sessionId];
    if (!view || view.roundId !== at.roundId) return state;
    const current = grillUiFor(state, at.sessionId);
    if (!current) return state;
    const next = change(current);
    if (next === state.ui[at.sessionId]) return state;
    return {...state, ui: withEntry(state.ui, at.sessionId, next)};
}

/** The card's working state for the session's open round; a fresh one when the card has not touched it. */
export function grillUiFor(state: GrillState, sessionId: string | null | undefined): GrillCardUi | undefined {
    const view = sessionId ? state.views[sessionId] : undefined;
    if (!view || !sessionId) return undefined;
    const ui = state.ui[sessionId];
    return ui && ui.roundId === view.roundId ? ui : freshUi(view.roundId, view.revision);
}

/** A re-keyed session keeps its round, its working state and its calls in flight. */
export function rekeyGrill(state: GrillState, oldId: string, newId: string): GrillState {
    const views = movedEntry(state.views, oldId, newId);
    const ui = movedEntry(state.ui, oldId, newId);
    const inFlight = movedEntry(state.inFlight, oldId, newId);
    if (views === state.views && ui === state.ui && inFlight === state.inFlight) return state;
    const moved = views[newId];
    return {
        ...state,
        views: moved && moved.sessionId !== newId ? withEntry(views, newId, {...moved, sessionId: newId}) : views,
        ui,
        inFlight,
    };
}
