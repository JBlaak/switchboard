import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {initialRendererState, rootReducer} from '../src/renderer/state/root';
import {chosenPlan, planRefresh, planSourceKey} from '../src/renderer/state/plan-slice';
import type {PlanSource, SessionPlansAnswer} from '../src/renderer/state/plan-slice';
import type {RendererEvent} from '../src/renderer/state/events';
import type {RendererState} from '../src/renderer/state/root';
import {
    STORED_PLANS_MAX,
    findStoredPlan,
    parseStoredPlans,
    withStoredPlan,
} from '../src/renderer/ui/session-work/plan/stored-plans';
import {PlanViewContent} from '../src/renderer/ui/session-work/plan/PlanViewContent';
import {diamond, issue, key, merged, plan, REPO} from './support/plans';

function run(state: RendererState, ...events: RendererEvent[]): RendererState {
    return events.reduce((s, e) => rootReducer(Object.freeze(s), e), state);
}

const OWNER = 'project-plan:/p:acme/app#1';
const SOURCE: PlanSource = {kind: 'plan', repository: REPO, number: 1};
const SOURCE_KEY = planSourceKey(SOURCE);

function answerOf(...plans: ReturnType<typeof plan>[]): SessionPlansAnswer {
    return {plans, others: []};
}

function opened(): RendererState {
    return run(initialRendererState(), {type: 'planViewOpened', owner: OWNER, source: SOURCE});
}

function seeded(stored = diamond()): RendererState {
    return run(opened(), {type: 'planSeeded', owner: OWNER, sourceKey: SOURCE_KEY, answer: answerOf(stored)});
}

// ── The slice ──

test('a stored plan shows at once while the view is still refreshing', () => {
    /* When */
    const state = seeded();

    /* Then */
    const view = state.plan.view!;
    assert.equal(view.phase, 'loading');
    assert.equal(chosenPlan(view)?.title, 'Epic');
    assert.equal(planRefresh(view), 'refreshing');
});

test('main’s answer replaces the stored plan and ends the refresh', () => {
    /* Given */
    const state = seeded(plan([issue(10)], {title: 'Old title'}));

    /* When */
    const next = run(state, {type: 'planLoaded', owner: OWNER, sourceKey: SOURCE_KEY, answer: answerOf(diamond())});

    /* Then */
    assert.equal(next.plan.view?.phase, 'loaded');
    assert.equal(chosenPlan(next.plan.view!)?.title, 'Epic');
    assert.equal(planRefresh(next.plan.view!), null);
});

test('a stored plan never covers an answer already on screen', () => {
    /* Given */
    const state = run(opened(), {type: 'planLoaded', owner: OWNER, sourceKey: SOURCE_KEY, answer: answerOf(diamond())});

    /* When */
    const next = run(state, {
        type: 'planSeeded',
        owner: OWNER,
        sourceKey: SOURCE_KEY,
        answer: answerOf(plan([], {title: 'Stale'})),
    });

    /* Then */
    assert.equal(next, state);
});

test('a stored plan for another view or source is ignored', () => {
    /* Given */
    const state = opened();

    /* When */
    const otherOwner = run(state, {
        type: 'planSeeded',
        owner: 'elsewhere',
        sourceKey: SOURCE_KEY,
        answer: answerOf(diamond()),
    });
    const otherSource = run(state, {
        type: 'planSeeded',
        owner: OWNER,
        sourceKey: 'plan:x/y#9',
        answer: answerOf(diamond()),
    });

    /* Then */
    assert.equal(otherOwner, state);
    assert.equal(otherSource, state);
});

test('when main cannot answer, the stored plan stays and says it could not refresh', () => {
    /* Given */
    const state = seeded();

    /* When */
    const next = run(state, {type: 'planLoaded', owner: OWNER, sourceKey: SOURCE_KEY, answer: null});

    /* Then */
    assert.equal(next.plan.view?.phase, 'failed');
    assert.equal(chosenPlan(next.plan.view!)?.title, 'Epic');
    assert.equal(planRefresh(next.plan.view!), 'failed');
});

test('a failed poll after main answered still keeps the view quietly loaded', () => {
    /* Given */
    const state = run(seeded(), {type: 'planLoaded', owner: OWNER, sourceKey: SOURCE_KEY, answer: answerOf(diamond())});

    /* When */
    const next = run(state, {type: 'planLoaded', owner: OWNER, sourceKey: SOURCE_KEY, answer: null});

    /* Then */
    assert.equal(next, state);
    assert.equal(planRefresh(next.plan.view!), null);
});

test('a stored plan claims no sessions: owners wait for the live answer', () => {
    /* When */
    const state = seeded();

    /* Then */
    assert.deepEqual(state.plan.view?.owners, {});
});

test('a stored plan is not a sighting: only main’s answer can celebrate (A4)', () => {
    /* Given */
    const before = run(initialRendererState(), {type: 'planLevelsSeenRestored', seen: {'acme/app#1': 1}});
    const cleared = plan([merged(10), merged(11, [10])]);

    /* When */
    const state = run(
        before,
        {type: 'planViewOpened', owner: OWNER, source: SOURCE},
        {type: 'planSeeded', owner: OWNER, sourceKey: SOURCE_KEY, answer: answerOf(cleared)},
    );

    /* Then */
    assert.equal(state.plan.celebration, null);
    assert.equal(state.plan.levelsSeen['acme/app#1'], 1);
});

test('an issue can be selected on a stored plan while it refreshes', () => {
    /* Given */
    const state = seeded();

    /* When */
    const next = run(state, {type: 'planIssueSelected', issue: key(12)});

    /* Then */
    assert.deepEqual(next.plan.view?.selected, key(12));
});

// ── The store ──

test('a stored plan goes first and replaces its older copy', () => {
    /* Given */
    const stored = withStoredPlan(withStoredPlan([], plan([], {number: 1, title: 'Old'})), plan([], {number: 2}));

    /* When */
    const next = withStoredPlan(stored, plan([], {number: 1, title: 'New'}));

    /* Then */
    assert.deepEqual(
        next.map((p) => [p.number, p.title]),
        [
            [1, 'New'],
            [2, 'Epic'],
        ],
    );
});

test('the store keeps only the newest plans', () => {
    /* Given */
    let stored = withStoredPlan([], plan([], {number: 1}));
    for (let n = 2; n <= STORED_PLANS_MAX + 5; n++) stored = withStoredPlan(stored, plan([], {number: n}));

    /* When */
    const oldest = findStoredPlan(stored, key(1));
    const newest = findStoredPlan(stored, key(STORED_PLANS_MAX + 5));

    /* Then */
    assert.equal(stored.length, STORED_PLANS_MAX);
    assert.equal(oldest, null);
    assert.equal(newest?.number, STORED_PLANS_MAX + 5);
});

test('only the plan’s own fields are stored', () => {
    /* Given */
    const extra = {...diamond(), sessions: {'acme/app#12': 's1'}};

    /* When */
    const [stored] = withStoredPlan([], extra);

    /* Then */
    assert.deepEqual(Object.keys(stored).sort(), ['issues', 'number', 'outside', 'parent', 'repository', 'title']);
});

test('the store reads back what it wrote, and drops what it cannot read', () => {
    /* Given */
    const written = JSON.stringify([diamond(), {repository: 'acme/app'}, 'nonsense', plan([], {number: 2})]);

    /* When */
    const read = parseStoredPlans(written);
    const broken = parseStoredPlans('{not json');
    const missing = parseStoredPlans(null);

    /* Then */
    assert.deepEqual(
        read.map((p) => p.number),
        [1, 2],
    );
    assert.deepEqual(read[0], diamond());
    assert.deepEqual(broken, []);
    assert.deepEqual(missing, []);
});

// ── The view ──

test('the header says quietly when the plan is a stored copy', () => {
    /* When */
    const refreshing = renderToStaticMarkup(createElement(PlanViewContent, {plan: diamond(), refresh: 'refreshing'}));
    const failed = renderToStaticMarkup(createElement(PlanViewContent, {plan: diamond(), refresh: 'failed'}));
    const fresh = renderToStaticMarkup(createElement(PlanViewContent, {plan: diamond()}));

    /* Then */
    assert.match(refreshing, /Refreshing…/);
    assert.match(failed, /Couldn’t refresh/);
    assert.doesNotMatch(fresh, /plan-refresh/);
});
