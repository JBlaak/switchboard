/**
 * Land it and Unland (#436, for #432): when a pull request is offered Land
 * it, and what each place says once it is landed.
 *
 * Land it is offered in four places (the session header, the sidebar row, the
 * session tray and the project page's PR rows), always by the same rule: only
 * on the user's own open PRs, disabled on a draft ("Mark it ready for review
 * first"), and replaced by the PR's stage once it is landed. A merged or
 * closed PR, or a teammate's, gets nothing.
 *
 * The words follow the design (Land it section): the header's pill says
 * "Landed · 2nd in switchboard", the toast "Landed #432 · 2nd in
 * switchboard's lane", and the sidebar's pill the stage in a word or two
 * ("landed · 2nd", "held · @ana", "merging", "fixing", "needs you").
 */
import {landedKey} from './model';
import type {HeldReason, LandedView, LaneStage, MergeManagerState} from './model';
import type {LinkedPr} from '../session/links';

/** The hint a draft's disabled Land it carries. */
export const DRAFT_HINT = 'Mark it ready for review first';

/** A PR as a place that offers Land it knows it. */
export interface LandCandidate {
    readonly repository: string;
    readonly number: number;
    readonly state: 'open' | 'draft' | 'merged' | 'closed';
    /** The user `gh` signs in as opened it. */
    readonly mine: boolean;
}

/** What a place shows for a PR: Land it, Land it disabled on a draft, its landed stage, or nothing. */
export type LandOffer =
    | {readonly kind: 'land'}
    | {readonly kind: 'draft'; readonly hint: string}
    | {readonly kind: 'landed'; readonly landed: LandedView}
    | null;

/** What a place offers for `pr`, given the Merge manager's lanes. */
export function landOffer(pr: LandCandidate, state: MergeManagerState): LandOffer {
    if (!pr.repository) return null;
    const landed = findLanded(state, pr.repository, pr.number);
    if (landed) return {kind: 'landed', landed};
    if (!pr.mine) return null;
    if (pr.state === 'draft') return {kind: 'draft', hint: DRAFT_HINT};
    if (pr.state === 'open') return {kind: 'land'};
    return null;
}

/** A PR's place in its lane, or null when it is not landed. */
export function findLanded(state: MergeManagerState, repository: string, number: number): LandedView | null {
    const key = landedKey(repository, number);
    for (const lane of state.lanes) {
        const found = lane.pullRequests.find((pr) => pr.key === key);
        if (found) return found;
    }
    return null;
}

/** 1st, 2nd, 3rd, 4th, 11th, 21st, … */
export function ordinal(n: number): string {
    const tens = n % 100;
    if (tens >= 11 && tens <= 13) return `${n}th`;
    return `${n}${n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'}`;
}

/** A repository's short name: `switchboard` for `JBlaak/switchboard`. */
export function repositoryName(repository: string): string {
    return repository.slice(repository.indexOf('/') + 1);
}

/** Where a landed PR stands, in a few words: "2nd in switchboard", or its stage when it has no place. */
function standing(view: LandedView): string {
    if (view.place !== null) return `${ordinal(view.place)} in ${repositoryName(view.repository)}`;
    return stageWords(view.stage);
}

/** The header's landed pill: "Landed · 2nd in switchboard", "Landed · held · approval", "Merged". */
export function landedPillText(view: LandedView): string {
    if (view.stage.kind === 'merged') return 'Merged';
    return `Landed · ${standing(view)}`;
}

/** The toast after landing: "Landed #432 · 2nd in switchboard's lane". */
export function landedToastText(view: LandedView): string {
    return `Landed #${view.number} · ${laneStanding(view)}`;
}

/** "2nd in switchboard's lane", or "held · approval in switchboard's lane" without a place. */
function laneStanding(view: LandedView): string {
    const lane = `${repositoryName(view.repository)}'s lane`;
    return `${view.place !== null ? ordinal(view.place) : stageWords(view.stage)} in ${lane}`;
}

/** A sidebar row's pill for a landed PR: its stage in a word or two. */
export interface LandedPill {
    readonly kind: LaneStage['kind'];
    readonly text: string;
    /** The full sentence, for a tooltip. */
    readonly title: string;
}

export function landedPill(view: LandedView): LandedPill {
    const title = `#${view.number} · ${laneStanding(view)}`;
    switch (view.stage.kind) {
        case 'waiting':
            return {
                kind: 'waiting',
                text: view.place !== null ? `landed · ${ordinal(view.place)}` : 'landed',
                title: view.stage.willConflict ? title + ' · will conflict' : title,
            };
        case 'head':
            return {kind: 'head', text: 'merging', title};
        default:
            return {kind: view.stage.kind, text: stageWords(view.stage), title};
    }
}

/** A stage in the shared words (#441 makes them the same everywhere). */
export function stageWords(stage: LaneStage): string {
    switch (stage.kind) {
        case 'waiting':
            return 'waiting';
        case 'held':
            return `held · ${heldWords(stage.reason)}`;
        case 'head':
            return 'merging';
        case 'fixing':
            return 'fixing';
        case 'needsYou':
            return 'needs you';
        case 'merged':
            return 'merged';
    }
}

function heldWords(reason: HeldReason): string {
    switch (reason.kind) {
        case 'approval':
            return 'approval';
        case 'review':
            return '@' + reason.reviewer;
        case 'base':
            return 'on ' + reason.base;
        case 'draft':
            return 'draft';
    }
}

// ── A session's pull requests ──

/** A PR as a session knows it before `gh` has said how it is doing: its number and repository. */
export interface SessionPullRequestRef {
    readonly repository: string;
    readonly number: number;
}

/**
 * The PR a session offers Land it for, from its PRs as `gh` read them (newest
 * first): its newest one still open, a draft included, or else its newest one
 * `gh` knows, which shows only when it was landed (Merged).
 */
export function sessionLandCandidate(prs: readonly LinkedPr[]): LandCandidate | null {
    const known = prs.filter((pr) => pr.repository && pr.status);
    const pr = known.find((p) => p.status!.state === 'open' || p.status!.state === 'draft') ?? known[0];
    if (!pr?.status) return null;
    return {repository: pr.repository, number: pr.number, state: pr.status.state, mine: pr.status.mine};
}

/** The newest of a session's PRs that is landed, or null. `prs` is chronological, as the session's row has them. */
export function sessionLanded(prs: readonly SessionPullRequestRef[], state: MergeManagerState): LandedView | null {
    for (const pr of [...prs].reverse()) {
        const landed = pr.repository ? findLanded(state, pr.repository, pr.number) : null;
        if (landed) return landed;
    }
    return null;
}
