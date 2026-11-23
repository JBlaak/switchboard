/**
 * The Merge manager (#434), renderer side: every lane with a landed PR and
 * how many PRs need you, as main pushed them last (`mergeManagerChanged`),
 * for Land it, the Merge manager's page and its figure (#436, #439, #440).
 *
 * Land it (#436) keeps three more things here:
 *
 * - each session's pull requests as `gh` read them (its links' PRs), for the
 *   session header's Land it, which needs to know a draft and whose PR it is;
 * - which PRs a Land it or Unland is under way for, so its button waits;
 * - the toast a land brings: "Landed #432 · 2nd in switchboard's lane", with
 *   Undo, or why it did not land. A newer one replaces it.
 *
 * And its page (#439, ⌘⇧L): the selected row and whether its side view is
 * open, what main answered for the page besides the lanes (CI saved, the
 * errands, the checkouts, the CI run times), the note
 * typed for each Try again and how each went, and a line of what came of
 * the last action.
 *
 * The events are declared here rather than in `events.ts`, like the archive
 * undo's, so the vocabulary stays in one file.
 */
import {EMPTY_MERGE_MANAGER_STATE, landedKey} from '../../domain/merge-manager/model';
import {landedToastText} from '../../domain/merge-manager/land-it';
import {findLanded} from '../../domain/merge-manager/stage-words';
import {movedEntry, withEntry, withoutEntry, type IdRecord} from './records';
import type {LandedView, MergeManagerState} from '../../domain/merge-manager/model';
import type {MergeManagerPageFacts} from '../../domain/merge-manager/page';
import type {OpenPullRequest} from '../../domain/merge-manager/not-landed';
import type {LinkedPr} from '../../domain/session/links';
import type {RendererEvent} from './events';

export type LandAction = 'land' | 'unland';

export type MergeManagerEvent =
    /** A session's PRs, as `gh` read them for its links. */
    | {type: 'sessionPullRequestsLoaded'; sessionId: string; pullRequests: readonly LinkedPr[]}
    /** Land it or Unland was pressed for a PR. */
    | {type: 'landStarted'; repository: string; number: number; action: LandAction}
    /** What main answered: the PR in its lane, or why not. */
    | {
          type: 'landFinished';
          repository: string;
          number: number;
          action: LandAction;
          result: {ok: true; landed: LandedView | null} | {ok: false; reason: string};
      }
    /** The toast timed out, was put away, or its Undo was pressed. */
    | {type: 'landToastClosed'; id: number}
    /**
     * The Merge manager's page asked for (#439): ⌘⇧L, its figure on the empty
     * screen (#440), Open in Merge manager. `key` selects that PR's row.
     */
    | {type: 'mergeManagerPageRequested'; key?: string}
    /** Esc or ⌘⇧L on the page. */
    | {type: 'mergeManagerPageClosed'}
    /** A row chosen: a click, J/K. It opens the side view. */
    | {type: 'mergeManagerRowSelected'; key: string | null}
    /** Esc, its ×, or a click on the row it shows. */
    | {type: 'mergeManagerDetailClosed'}
    /** What main answered for the page besides the lanes. */
    | {type: 'mergeManagerPageFactsLoaded'; facts: MergeManagerPageFacts}
    /** The note for a PR's next Try again, as typed. */
    | {type: 'mergeManagerTryAgainNoteTyped'; key: string; note: string}
    | {type: 'mergeManagerTryAgainAsked'; key: string}
    | {type: 'mergeManagerTryAgainAnswered'; key: string; result: {ok: true} | {ok: false; reason: string}}
    /** What came of an action on the page, said once under its header; null puts it away. */
    | {type: 'mergeManagerPageNoticed'; notice: string | null}
    /**
     * Your open PRs as main read them for Not landed; null when `gh` could not
     * say (the last good read is kept), with when GitHub was last read well
     * for them and whether the latest read failed.
     */
    | {
          type: 'mergeManagerNotLandedLoaded';
          pullRequests: readonly OpenPullRequest[] | null;
          fetchedAt: number | null;
          failed: boolean;
      }
    /** View all (the Not landed page), or back to the lanes (Esc, its back button). */
    | {type: 'mergeManagerViewChanged'; view: MergeManagerView}
    /** A project chip on the Not landed page; null is All. */
    | {type: 'mergeManagerNotLandedFiltered'; repository: string | null};

/** What the Merge manager's page shows: its lanes and Not landed's newest five, or the Not landed page. */
export type MergeManagerView = 'lanes' | 'notLanded';

/** How a Try again from the page went. */
export type TryAgainPhase = {readonly phase: 'busy'} | {readonly phase: 'failed'; readonly reason: string};

/** The Merge manager's page (#439). */
export interface MergeManagerPageState {
    /** The selected row's key (`landedKey`); null for none yet. */
    readonly selected: string | null;
    /** The selected row's side view is open; closed as the page opens, so the lanes have the width. */
    readonly detailOpen: boolean;
    readonly facts: MergeManagerPageFacts | null;
    /** `landedKey` → the note typed for its next Try again. */
    readonly notes: IdRecord<string>;
    /** `landedKey` → a Try again under way, or why the last one failed. */
    readonly tryAgain: IdRecord<TryAgainPhase>;
    readonly notice: string | null;
    /** The lanes, or the Not landed page; the lanes each time the page is asked for. */
    readonly view: MergeManagerView;
    /** The Not landed page's project chip (`owner/repo`); null for All. */
    readonly repository: string | null;
}

/** The toast a Land it brings. */
export type LandToast =
    | {
          readonly id: number;
          readonly kind: 'landed';
          readonly text: string;
          readonly repository: string;
          readonly number: number;
      }
    | {readonly id: number; readonly kind: 'failed'; readonly text: string};

export interface MergeManagerSliceState {
    readonly state: MergeManagerState;
    /** sessionId → its PRs, newest first. */
    readonly sessionPullRequests: IdRecord<readonly LinkedPr[]>;
    /** `landedKey` → the Land it or Unland under way for it. */
    readonly busy: IdRecord<LandAction>;
    /** `landedKey` → why its last Land it failed, until it is pressed again or lands. */
    readonly landFailures: IdRecord<string>;
    readonly toast: LandToast | null;
    /** The id the next toast takes, so a timer left over from an older one closes nothing. */
    readonly nextToastId: number;
    readonly page: MergeManagerPageState;
    /** Your open PRs, lanes or not, as main last read them (Not landed); null until the first good read. */
    readonly notLanded: readonly OpenPullRequest[] | null;
    /** When GitHub was last read well for `notLanded`; null until then. */
    readonly notLandedFetchedAt: number | null;
    /** The latest Not landed read failed, so `notLanded` is older. */
    readonly notLandedFailed: boolean;
}

export const initialMergeManagerState: MergeManagerSliceState = {
    state: EMPTY_MERGE_MANAGER_STATE,
    sessionPullRequests: {},
    busy: {},
    landFailures: {},
    toast: null,
    nextToastId: 1,
    page: {
        selected: null,
        detailOpen: false,
        facts: null,
        notes: {},
        tryAgain: {},
        notice: null,
        view: 'lanes',
        repository: null,
    },
    notLanded: null,
    notLandedFetchedAt: null,
    notLandedFailed: false,
};

export function mergeManagerReducer(state: MergeManagerSliceState, event: RendererEvent): MergeManagerSliceState {
    switch (event.type) {
        case 'mergeManagerChanged':
            return {...state, state: event.state};
        case 'sessionPullRequestsLoaded':
            return {
                ...state,
                sessionPullRequests: withEntry(state.sessionPullRequests, event.sessionId, event.pullRequests),
            };
        case 'landStarted': {
            const key = landedKey(event.repository, event.number);
            const landFailures = event.action === 'land' ? withoutEntry(state.landFailures, key) : state.landFailures;
            return {...state, busy: withEntry(state.busy, key, event.action), landFailures};
        }
        case 'landFinished': {
            const key = landedKey(event.repository, event.number);
            const busy = withoutEntry(state.busy, key);
            const landFailures =
                event.action !== 'land'
                    ? state.landFailures
                    : event.result.ok
                      ? withoutEntry(state.landFailures, key)
                      : withEntry(state.landFailures, key, event.result.reason);
            const toast = finishedToast(event, state.nextToastId, state.state);
            if (!toast)
                return {...state, busy, landFailures, toast: closesToast(state.toast, event) ? null : state.toast};
            return {...state, busy, landFailures, toast, nextToastId: state.nextToastId + 1};
        }
        case 'landToastClosed':
            return state.toast?.id === event.id ? {...state, toast: null} : state;
        case 'mergeManagerNotLandedLoaded':
            return {
                ...state,
                notLanded: event.pullRequests ?? state.notLanded,
                notLandedFetchedAt: event.fetchedAt ?? state.notLandedFetchedAt,
                notLandedFailed: event.failed,
            };
        default: {
            const page = pageReducer(state.page, event);
            return page === state.page ? state : {...state, page};
        }
    }
}

function pageReducer(page: MergeManagerPageState, event: RendererEvent): MergeManagerPageState {
    switch (event.type) {
        case 'mergeManagerPageRequested': {
            // Open in Merge manager shows that PR's side view; ⌘⇧L keeps the page as it was.
            const selected = event.key ?? page.selected;
            const detailOpen = event.key ? true : page.detailOpen;
            return page.notice === null &&
                selected === page.selected &&
                detailOpen === page.detailOpen &&
                page.view === 'lanes'
                ? page
                : {...page, notice: null, selected, detailOpen, view: 'lanes'};
        }
        case 'mergeManagerPageClosed':
            return page.detailOpen ? {...page, detailOpen: false} : page;
        case 'mergeManagerRowSelected': {
            const detailOpen = event.key !== null;
            return page.selected === event.key && page.detailOpen === detailOpen
                ? page
                : {...page, selected: event.key, detailOpen};
        }
        case 'mergeManagerDetailClosed':
            return page.detailOpen ? {...page, detailOpen: false} : page;
        case 'mergeManagerPageFactsLoaded':
            return {...page, facts: event.facts};
        case 'mergeManagerTryAgainNoteTyped':
            return {...page, notes: withEntry(page.notes, event.key, event.note)};
        case 'mergeManagerTryAgainAsked':
            return {...page, tryAgain: withEntry(page.tryAgain, event.key, {phase: 'busy'} as TryAgainPhase)};
        case 'mergeManagerTryAgainAnswered':
            if (event.result.ok) {
                return {
                    ...page,
                    notes: withoutEntry(page.notes, event.key),
                    tryAgain: withoutEntry(page.tryAgain, event.key),
                };
            }
            return {
                ...page,
                tryAgain: withEntry(page.tryAgain, event.key, {
                    phase: 'failed',
                    reason: event.result.reason,
                } as TryAgainPhase),
            };
        case 'mergeManagerViewChanged':
            // Each view starts with its side view closed.
            return page.view === event.view ? page : {...page, view: event.view, detailOpen: false};
        case 'mergeManagerNotLandedFiltered':
            return page.repository === event.repository ? page : {...page, repository: event.repository};
        case 'mergeManagerPageNoticed':
            return page.notice === event.notice ? page : {...page, notice: event.notice};
        default:
            return page;
    }
}

/** The toast a finished Land it or Unland brings: landed, or why either failed. Unland's success brings none. */
function finishedToast(
    event: Extract<MergeManagerEvent, {type: 'landFinished'}>,
    id: number,
    lanes: MergeManagerState,
): LandToast | null {
    const {result, repository, number} = event;
    if (!result.ok) {
        const verb = event.action === 'land' ? 'land' : 'unland';
        return {id, kind: 'failed', text: `Could not ${verb}${number ? ' #' + number : ''}: ${result.reason}`};
    }
    if (event.action !== 'land') return null;
    const lane = result.landed ? findLanded(lanes, result.landed.repository, result.landed.number)?.lane : undefined;
    const text = result.landed ? landedToastText(result.landed, lane) : `Landed #${number}`;
    return {id, kind: 'landed', text, repository, number};
}

/** An unland puts away the toast that offered to undo landing that PR. */
function closesToast(toast: LandToast | null, event: Extract<MergeManagerEvent, {type: 'landFinished'}>): boolean {
    return (
        toast?.kind === 'landed' &&
        event.action === 'unland' &&
        landedKey(toast.repository, toast.number) === landedKey(event.repository, event.number)
    );
}

/** How many landed PRs need you. */
export function needsYouCount(state: MergeManagerSliceState): number {
    return state.state.needsYou;
}

/** Whether a push is news to the page: a VM's always, this Mac's when it says more than how fresh the lanes are. */
export function lanesChanged(before: MergeManagerState, after: MergeManagerState): boolean {
    if (after.merging?.kind === 'vm') return true;
    const {freshness: _before, ...was} = before;
    const {freshness: _after, ...is} = after;
    return JSON.stringify(was) !== JSON.stringify(is);
}

/** Whether a Land it or Unland is under way for a PR. */
export function landBusy(state: MergeManagerSliceState, repository: string, number: number): LandAction | null {
    return state.busy[landedKey(repository, number)] ?? null;
}

/** Why the last Land it for a PR failed; null when it did not, or is pressed again. */
export function landFailure(state: MergeManagerSliceState, repository: string, number: number): string | null {
    return state.landFailures[landedKey(repository, number)] ?? null;
}

/** A re-keyed session keeps its PRs; see `rekeyState` in `root`. */
export function rekeyMergeManager(state: MergeManagerSliceState, oldId: string, newId: string): MergeManagerSliceState {
    const sessionPullRequests = movedEntry(state.sessionPullRequests, oldId, newId);
    return sessionPullRequests === state.sessionPullRequests ? state : {...state, sessionPullRequests};
}
