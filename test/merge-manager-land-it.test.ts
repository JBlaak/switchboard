/** Land it (#436): when it is offered, what each place says once a PR is landed, and its toast. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import './support/static-markup-dom';
import {
    DRAFT_HINT,
    landOffer,
    landedPillText,
    landedToastText,
    sessionLandCandidate,
    type LandCandidate,
} from '../src/domain/merge-manager/land-it';
import {mergeManagerState} from '../src/domain/merge-manager/landed';
import {EMPTY_MERGE_MANAGER_STATE} from '../src/domain/merge-manager/model';
import {LandItControl} from '../src/renderer/ui/merge-manager/LandIt';
import {HEAD, REPO, landedPr} from './support/merge-manager-fixtures';
import type {LandItControlProps} from '../src/renderer/ui/merge-manager/LandIt';
import type {LaneStage, MergeManagerState} from '../src/domain/merge-manager/model';
import type {LinkedPr} from '../src/domain/session/links';

const WAITING: LaneStage = {kind: 'waiting', willConflict: false, position: null};

function candidate(number: number, fields: Partial<LandCandidate> = {}): LandCandidate {
    return {repository: REPO, number, state: 'open', mine: true, ...fields};
}

/** A Switchboard lane with #1 as its head, and #2 waiting behind it. */
function lanes(): MergeManagerState {
    return mergeManagerState(
        [landedPr(1, 30, 'switchboard', HEAD), landedPr(2, 10, 'switchboard', WAITING)],
        new Map(),
    );
}

function linked(number: number, status: LinkedPr['status']): LinkedPr {
    return {
        kind: 'pr',
        key: `pr:https://github.com/${REPO}/pull/${number}`,
        title: `PR ${number}`,
        url: `https://github.com/${REPO}/pull/${number}`,
        repository: REPO,
        number,
        status,
    };
}

const open = (mine = true): LinkedPr['status'] => ({state: 'open', checks: 'passing', dot: 'green', mine});

// ── When Land it is offered ──

test('your own open PR is offered Land it', () => {
    /* When */
    const offer = landOffer(candidate(5), EMPTY_MERGE_MANAGER_STATE);

    /* Then */
    assert.deepEqual(offer, {kind: 'land'});
});

test('a draft is offered Land it disabled, with the hint to mark it ready', () => {
    /* When */
    const offer = landOffer(candidate(5, {state: 'draft'}), EMPTY_MERGE_MANAGER_STATE);

    /* Then */
    assert.deepEqual(offer, {kind: 'draft', hint: 'Mark it ready for review first'});
});

test("a teammate's PR, a merged one and a closed one are offered nothing", () => {
    /* When */
    const offers = [
        landOffer(candidate(5, {mine: false}), EMPTY_MERGE_MANAGER_STATE),
        landOffer(candidate(6, {state: 'merged'}), EMPTY_MERGE_MANAGER_STATE),
        landOffer(candidate(7, {state: 'closed'}), EMPTY_MERGE_MANAGER_STATE),
        landOffer(candidate(8, {repository: ''}), EMPTY_MERGE_MANAGER_STATE),
    ];

    /* Then */
    assert.deepEqual(offers, [null, null, null, null]);
});

test('a landed PR shows its place in the lane instead of Land it', () => {
    /* When */
    const offer = landOffer(candidate(2), lanes());

    /* Then */
    assert.equal(offer?.kind, 'landed');
    assert.equal(offer?.kind === 'landed' && offer.landed.place, 2);
});

// ── What it says ──

test("the toast and the header's pill say the PR's place in its repository's lane", () => {
    /* Given */
    const second = landOffer(candidate(2), lanes());
    assert.equal(second?.kind, 'landed');
    const view = second!.kind === 'landed' ? second!.landed : null;

    /* Then */
    assert.equal(landedToastText(view!), "Landed #2 · 2nd in connect's lane");
    assert.equal(landedPillText(view!), 'Landed · 2nd in connect');
});

test('a PR landed before its approval says it is held, as it has no place yet', () => {
    /* Given */
    const state = mergeManagerState(
        [landedPr(3, 5, 'switchboard', {kind: 'held', reason: {kind: 'approval'}})],
        new Map(),
    );
    const offer = landOffer(candidate(3), state);
    const view = offer?.kind === 'landed' ? offer.landed : null;

    /* Then */
    assert.equal(landedToastText(view!), "Landed #3 · held · approval in connect's lane");
    assert.equal(landedPillText(view!), 'Landed · held · approval');
});

// ── A session's PRs ──

test('a session offers Land it for its newest open PR, a merged one after it left out', () => {
    /* Given: newest first, as the links list them */
    const prs = [linked(9, {state: 'merged', checks: 'passing', dot: 'merged', mine: true}), linked(8, open())];

    /* When */
    const pr = sessionLandCandidate(prs);

    /* Then */
    assert.deepEqual(pr, candidate(8));
});

test('a session whose PRs gh has not read yet offers nothing in its header', () => {
    /* Then */
    assert.equal(sessionLandCandidate([linked(8, null)]), null);
});

// ── The control ──

function draw(props: Partial<LandItControlProps>): string {
    return renderToStaticMarkup(
        createElement(LandItControl, {offer: {kind: 'land'}, busy: null, onLand() {}, onUnland() {}, ...props}),
    );
}

test('Land it is a button, disabled on a draft with the hint as its tooltip', () => {
    /* When */
    const land = draw({});
    const draft = draw({offer: {kind: 'draft', hint: DRAFT_HINT}});

    /* Then */
    assert.match(land, /<button[^>]*class="land-it"[^>]*>Land it<\/button>/);
    assert.doesNotMatch(land, /disabled/);
    assert.match(draft, /disabled=""/);
    assert.match(draft, /title="Mark it ready for review first"/);
});

test('a landed PR shows its stage as a pill with a menu, in place of Land it', () => {
    /* Given */
    const offer = landOffer(candidate(2), lanes());

    /* When */
    const html = draw({offer});

    /* Then */
    assert.match(html, /class="landed-pill"[^>]*aria-haspopup="menu"/);
    assert.match(html, /Landed · 2nd in connect/);
    assert.doesNotMatch(html, />Land it</);
});
