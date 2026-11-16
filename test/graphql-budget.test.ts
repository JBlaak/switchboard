import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    BUDGET_RESERVE,
    ESSENTIAL_READS,
    EXPENSIVE_COST,
    GraphqlBudget,
    RATE_LIMITED_PAUSE_MS,
    SUMMARY_EVERY_MS,
    summaryLine,
    toBudgetAnswer,
    withBudget,
} from '../src/infrastructure/github/graphql-budget';
import {fakeTimers} from './support/fakes';

const MINUTE = 60_000;

/** A budget on a clock the test moves, logging into an array. */
function budget() {
    let now = 1_000_000;
    const lines: string[] = [];
    const tracker = new GraphqlBudget({clock: {now: () => now}, log: {info: (line: string) => lines.push(line)}});
    return {
        tracker,
        lines,
        advance: (ms: number) => (now += ms),
        at: (ms: number) => now + ms,
    };
}

test('points and calls add up per label, and the summary lists the biggest spender first', () => {
    /* Given */
    const {tracker, lines, advance, at} = budget();
    const resetAt = at(30 * MINUTE);
    tracker.answered('laneRead', {cost: 1, remaining: 4999, resetAt});
    tracker.answered('plan', {cost: 44, remaining: 4955, resetAt});
    tracker.answered('laneRead', {cost: 1, remaining: 4954, resetAt});
    tracker.answered('plansIn', {cost: 52, remaining: 4902, resetAt});
    tracker.answered('plansIn', {cost: 52, remaining: 4850, resetAt});

    /* When */
    advance(SUMMARY_EVERY_MS);
    tracker.answered('latestTag', {cost: 1, remaining: 4849, resetAt});

    /* Then */
    assert.equal(lines.length, 1);
    assert.match(
        lines[0],
        /^\[github\] GraphQL points since \d\d:\d\d: 151 — plansIn 104 \(2 calls\), plan 44 \(1 call\), laneRead 2 \(2 calls\), latestTag 1 \(1 call\); 4849 left, resets \d\d:\d\d$/,
    );
});

test('the summary is logged at most every ten minutes, and starts a new window', () => {
    /* Given */
    const {tracker, lines, advance, at} = budget();
    const resetAt = at(60 * MINUTE);
    advance(SUMMARY_EVERY_MS);
    tracker.answered('plan', {cost: 44, remaining: 4956, resetAt});

    /* When */
    advance(SUMMARY_EVERY_MS - 1);
    tracker.answered('plan', {cost: 44, remaining: 4912, resetAt});
    const beforeTen = lines.length;
    advance(1);
    tracker.answered('laneRead', {cost: 1, remaining: 4911, resetAt});

    /* Then */
    assert.equal(beforeTen, 1);
    assert.equal(lines.length, 2);
    assert.match(lines[1], /: 45 — plan 44 \(1 call\), laneRead 1 \(1 call\)/);
});

test('nothing is logged when nothing was spent', () => {
    /* Given */
    const {tracker, lines, advance} = budget();
    advance(SUMMARY_EVERY_MS);

    /* When */
    tracker.answered('plan', null);

    /* Then */
    assert.deepEqual(lines, []);
    assert.equal(summaryLine(new Map([['plan', {calls: 1, points: 0, held: 0, refused: 1}]]), 0, null, null), null);
});

test('below the reserve an expensive read is refused until the reset, and the pause is logged once', () => {
    /* Given */
    const {tracker, lines, at} = budget();
    tracker.answered('plansIn', {cost: 52, remaining: BUDGET_RESERVE - 1, resetAt: at(20 * MINUTE)});

    /* When */
    const first = tracker.allows('plansIn');
    const second = tracker.allows('plansIn');

    /* Then */
    assert.equal(first, false);
    assert.equal(second, false);
    assert.equal(lines.length, 1);
    assert.match(
        lines[0],
        /^\[github\] GraphQL budget low \(499 points left\): expensive reads paused until \d\d:\d\d$/,
    );
});

test('below the reserve a cheap read, or one whose cost is not known yet, still goes', () => {
    /* Given */
    const {tracker, at} = budget();
    const resetAt = at(20 * MINUTE);
    tracker.answered('laneRead', {cost: EXPENSIVE_COST - 1, remaining: 400, resetAt});
    tracker.answered('plan', {cost: 44, remaining: 356, resetAt});

    /* When */
    const cheap = tracker.allows('laneRead');
    const unknown = tracker.allows('pullRequestsIn');
    const expensive = tracker.allows('plan');

    /* Then */
    assert.equal(cheap, true);
    assert.equal(unknown, true);
    assert.equal(expensive, false);
});

test('below the reserve a lane read goes however much it cost', () => {
    /* Given */
    const {tracker, at} = budget();
    tracker.answered('laneRead', {cost: EXPENSIVE_COST + 5, remaining: 100, resetAt: at(20 * MINUTE)});

    /* When */
    const allowed = tracker.allows('laneRead');

    /* Then */
    assert.equal(ESSENTIAL_READS.has('laneRead'), true);
    assert.equal(allowed, true);
});

test('at or above the reserve an expensive read goes', () => {
    /* Given */
    const {tracker, at} = budget();
    tracker.answered('plan', {cost: 44, remaining: BUDGET_RESERVE, resetAt: at(20 * MINUTE)});

    /* When */
    const allowed = tracker.allows('plan');

    /* Then */
    assert.equal(allowed, true);
});

test('the reserve lifts once the reset time has passed', () => {
    /* Given */
    const {tracker, advance, at} = budget();
    tracker.answered('plan', {cost: 44, remaining: 10, resetAt: at(20 * MINUTE)});
    const during = tracker.allows('plan');

    /* When */
    advance(20 * MINUTE);

    /* Then */
    assert.equal(during, false);
    assert.equal(tracker.allows('plan'), true);
});

test('an answer from a fresh budget lifts the hold', () => {
    /* Given */
    const {tracker, at} = budget();
    tracker.answered('plan', {cost: 44, remaining: 10, resetAt: at(20 * MINUTE)});

    /* When */
    tracker.answered('laneRead', {cost: 1, remaining: 4800, resetAt: at(50 * MINUTE)});

    /* Then */
    assert.equal(tracker.allows('plan'), true);
});

test('a rate-limit refusal pauses expensive reads for five minutes, cheap ones still go', () => {
    /* Given */
    const {tracker, lines, advance, at} = budget();
    tracker.answered('plan', {cost: 44, remaining: 4000, resetAt: at(40 * MINUTE)});
    tracker.answered('laneRead', {cost: 1, remaining: 3999, resetAt: at(40 * MINUTE)});

    /* When */
    tracker.rateLimited('plansIn');

    /* Then */
    assert.equal(tracker.allows('plan'), false);
    assert.equal(tracker.allows('laneRead'), true);
    assert.match(lines[0], /^\[github\] GraphQL rate limit hit: expensive reads paused until/);
    advance(RATE_LIMITED_PAUSE_MS);
    assert.equal(tracker.allows('plan'), true);
});

test('after a rate-limit refusal the next answer with a budget decides again', () => {
    /* Given */
    const {tracker, at} = budget();
    tracker.answered('plan', {cost: 44, remaining: 4000, resetAt: at(40 * MINUTE)});
    tracker.rateLimited('plan');

    /* When */
    tracker.answered('laneRead', {cost: 1, remaining: 3000, resetAt: at(40 * MINUTE)});

    /* Then */
    assert.equal(tracker.allows('plan'), true);
});

test('held and rate-limited reads are counted in the summary', () => {
    /* Given */
    const {tracker, lines, advance, at} = budget();
    tracker.answered('plan', {cost: 44, remaining: 100, resetAt: at(60 * MINUTE)});
    tracker.allows('plan');
    tracker.rateLimited('plansIn');
    advance(SUMMARY_EVERY_MS);

    /* When */
    tracker.answered('laneRead', {cost: 1, remaining: 99, resetAt: at(60 * MINUTE)});

    /* Then */
    assert.match(lines.at(-1)!, /plan 44 \(1 call, 1 held\)/);
    assert.match(lines.at(-1)!, /plansIn 0 \(1 call, 1 rate-limited\)/);
});

test('the budget field is read from GitHub’s rateLimit, and a malformed one is no answer', () => {
    /* Given */
    const field = {cost: 3, remaining: 4210, resetAt: '2026-11-16T13:00:00Z'};

    /* When */
    const answer = toBudgetAnswer(field);

    /* Then */
    assert.deepEqual(answer, {cost: 3, remaining: 4210, resetAt: Date.parse('2026-11-16T13:00:00Z')});
    assert.equal(toBudgetAnswer(undefined), null);
    assert.equal(toBudgetAnswer({cost: 3, remaining: 4210, resetAt: 'soon'}), null);
});

test('the budget field goes into a query’s top-level selection, past its variables', () => {
    /* Given */
    const named = 'query($owner: String!, $name: String!) {\n  repository(owner: $owner, name: $name) { id }\n}';
    const bare = 'query { i0: repository(owner: "a", name: "b") { id } }';

    /* When */
    const withNamed = withBudget(named);
    const withBare = withBudget(bare);

    /* Then */
    assert.equal(
        withNamed,
        'query($owner: String!, $name: String!) { __budget: rateLimit { cost remaining resetAt }\n  repository(owner: $owner, name: $name) { id }\n}',
    );
    assert.equal(
        withBare,
        'query { __budget: rateLimit { cost remaining resetAt } i0: repository(owner: "a", name: "b") { id } }',
    );
});

test('a mutation is left as it is', () => {
    /* Given */
    const mutation =
        'mutation($id: ID!) { deletePullRequestReview(input: {pullRequestReviewId: $id}) { clientMutationId } }';

    /* When */
    const sent = withBudget(mutation);

    /* Then */
    assert.equal(sent, mutation);
});

// ── Telling whoever shows the hold ──

/** A budget with timers, and every hold it told about. */
function watchedBudget() {
    let now = 1_000_000;
    const timers = fakeTimers();
    const tracker = new GraphqlBudget({clock: {now: () => now}, log: {info: () => {}}, timers});
    const told: (number | null)[] = [];
    tracker.onHeldChanged((until) => told.push(until));
    return {tracker, timers, told, advance: (ms: number) => (now += ms), at: (ms: number) => now + ms};
}

test('a spent budget tells its hold until the reset, once', () => {
    /* Given */
    const {tracker, told, at} = watchedBudget();
    const resetAt = at(20 * MINUTE);

    /* When */
    tracker.answered('plan', {cost: 44, remaining: BUDGET_RESERVE - 1, resetAt});
    tracker.answered('plan', {cost: 44, remaining: BUDGET_RESERVE - 45, resetAt});

    /* Then */
    assert.deepEqual(told, [resetAt]);
});

test('a fresh budget tells nothing: there is no hold', () => {
    /* Given */
    const {tracker, told, at} = watchedBudget();

    /* When */
    tracker.answered('plan', {cost: 44, remaining: 4000, resetAt: at(20 * MINUTE)});

    /* Then */
    assert.deepEqual(told, []);
});

test('a rate-limit refusal tells its pause, and a spent answer after it moves the hold to the reset', () => {
    /* Given */
    const {tracker, told, at} = watchedBudget();
    const paused = at(RATE_LIMITED_PAUSE_MS);
    const resetAt = at(40 * MINUTE);

    /* When */
    tracker.rateLimited('plan');
    tracker.answered('plan', {cost: 44, remaining: 10, resetAt});

    /* Then */
    assert.deepEqual(told, [paused, resetAt]);
});

test('a fresh answer lifts the hold and tells so', () => {
    /* Given */
    const {tracker, timers, told, at} = watchedBudget();
    const resetAt = at(20 * MINUTE);
    tracker.answered('plan', {cost: 44, remaining: 10, resetAt});

    /* When */
    tracker.answered('plan', {cost: 44, remaining: 4900, resetAt: at(60 * MINUTE)});

    /* Then */
    assert.deepEqual(told, [resetAt, null]);
    assert.equal(timers.pending, 0);
});

test('the hold lifts by itself when its reset time passes', () => {
    /* Given */
    const {tracker, timers, told, advance, at} = watchedBudget();
    const resetAt = at(20 * MINUTE);
    tracker.answered('plan', {cost: 44, remaining: 10, resetAt});

    /* When */
    advance(20 * MINUTE);
    timers.tick();

    /* Then */
    assert.deepEqual(told, [resetAt, null]);
    assert.equal(tracker.heldUntil(), null);
    assert.equal(timers.pending, 0);
});

test('a timer woken before the reset keeps watching the same hold and tells nothing new', () => {
    /* Given */
    const {tracker, timers, told, advance, at} = watchedBudget();
    const resetAt = at(20 * MINUTE);
    tracker.answered('plan', {cost: 44, remaining: 10, resetAt});

    /* When */
    advance(20 * MINUTE - 5);
    timers.tick();

    /* Then */
    assert.deepEqual(told, [resetAt]);
    assert.equal(timers.pending, 1);
});

test('a pause ending under a spent budget moves the hold back to the reset', () => {
    /* Given */
    const {tracker, timers, told, advance, at} = watchedBudget();
    const resetAt = at(30 * MINUTE);
    tracker.answered('plan', {cost: 44, remaining: 10, resetAt});
    tracker.rateLimited('plan');
    const paused = at(RATE_LIMITED_PAUSE_MS);

    /* When */
    advance(RATE_LIMITED_PAUSE_MS);
    timers.tick();

    /* Then */
    assert.deepEqual(told, [resetAt, paused, resetAt]);
});

test('an unsubscribed listener is told nothing more', () => {
    /* Given */
    const tracker = new GraphqlBudget({clock: {now: () => 1_000_000}, log: {info: () => {}}});
    const told: (number | null)[] = [];
    const off = tracker.onHeldChanged((until) => told.push(until));
    off();

    /* When */
    tracker.rateLimited('plan');

    /* Then */
    assert.deepEqual(told, []);
});
