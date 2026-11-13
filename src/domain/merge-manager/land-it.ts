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
 * The header's pill says "Landed · 2nd in switchboard" and the toast
 * "Landed #432 · 2nd in switchboard's lane" (the design's Land it section);
 * past a place in the lane, both say the stage in the words every place
 * shares (`stage-words`, #441). The sidebar's pill is that table's own.
 */
import {findLanded, landedWords, ordinal, stageWords} from './stage-words';
import type {LandedView, LaneView, MergeManagerState} from './model';
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
    | {readonly kind: 'landed'; readonly landed: LandedView; readonly lane?: LaneView}
    | null;

/** What a place offers for `pr`, given the Merge manager's lanes. */
export function landOffer(pr: LandCandidate, state: MergeManagerState): LandOffer {
    if (!pr.repository) return null;
    const landed = findLanded(state, pr.repository, pr.number);
    if (landed) return {kind: 'landed', landed: landed.pullRequest, lane: landed.lane};
    if (!pr.mine) return null;
    if (pr.state === 'draft') return {kind: 'draft', hint: DRAFT_HINT};
    if (pr.state === 'open') return {kind: 'land'};
    return null;
}

/** A repository's short name: `switchboard` for `JBlaak/switchboard`. */
export function repositoryName(repository: string): string {
    return repository.slice(repository.indexOf('/') + 1);
}

/**
 * The header's landed pill: "Landed · 2nd in switchboard", "Landed · held ·
 * approval", "Merged". With its lane, a stacked PR's base is named as every
 * place names it ("held · on #433", #441).
 */
export function landedPillText(view: LandedView, lane?: LaneView): string {
    const words = lane ? landedWords({pullRequest: view, lane}) : stageWords(view.stage, view.place);
    if (view.stage.kind === 'merged') return words.label;
    if (view.place !== null) return `Landed · ${ordinal(view.place)} in ${repositoryName(view.repository)}`;
    return `Landed · ${words.pill}`;
}

/** The toast after landing: "Landed #432 · 2nd in switchboard's lane", or its stage without a place. */
export function landedToastText(view: LandedView, laneView?: LaneView): string {
    const lane = `${repositoryName(view.repository)}'s lane`;
    const words = laneView ? landedWords({pullRequest: view, lane: laneView}) : stageWords(view.stage, view.place);
    const where = view.place !== null ? ordinal(view.place) : words.pill;
    return `Landed #${view.number} · ${where} in ${lane}`;
}

// ── A session's pull requests ──

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
