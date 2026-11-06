import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    answerAgainst,
    answerAt,
    carry,
    matchQuestions,
    revise,
    revisionCounts,
    startAnswering,
} from '../src/domain/grill/answering';
import type {Answering, GrillAnswer, Round, RoundQuestion} from '../src/domain/grill/model';

/**
 * The draft answers to an open round, and how a revision of the round keeps,
 * sets aside, marks and drops them.
 */

const q = (
    number: number,
    title: string,
    reason = `Why ${title}.`,
    recommendation = `Do ${title}.`,
): RoundQuestion => ({
    number,
    title,
    reason,
    recommendation,
});
const round = (...questions: RoundQuestion[]): Round => ({preamble: '', questions});

const YES: GrillAnswer = {kind: 'accepted'};
const NOTED: GrillAnswer = {kind: 'noted', note: 'behind a flag'};
const OTHER: GrillAnswer = {kind: 'overridden', text: 'Not now'};

const state = (answering: Answering) =>
    answering.questions.map((a) => [a.question.number, a.question.title, a.answer, a.setAside, a.mark]);

test('a round as first posted has nothing answered and nothing marked', () => {
    /* Given */
    const posted = round(q(1, 'Cache'), q(2, 'Retry'));

    /* When */
    const answering = startAnswering(posted);

    /* Then */
    assert.deepEqual(answering.revision, 0);
    assert.deepEqual(answering.dropped, 0);
    assert.equal(answering.round, posted);
    assert.deepEqual(state(answering), [
        [1, 'Cache', null, null, null],
        [2, 'Retry', null, null, null],
    ]);
});

// ── Answering ──

test('an answer lands on its question, leaving the drafts it came from unchanged', () => {
    /* Given */
    const before = startAnswering(round(q(1, 'Cache'), q(2, 'Retry')));

    /* When */
    const after = answerAt(before, 1, NOTED);

    /* Then */
    assert.deepEqual(state(after), [
        [1, 'Cache', null, null, null],
        [2, 'Retry', NOTED, null, null],
    ]);
    assert.equal(before.questions[1].answer, null);
});

test('a fresh answer clears the set-aside answer but keeps the mark', () => {
    /* Given */
    const answered = answerAt(startAnswering(round(q(1, 'Cache'))), 0, YES);
    const revised = revise(answered, round(q(1, 'Cache', 'A new reason.')));

    /* When */
    const after = answerAt(revised, 0, OTHER);

    /* Then */
    assert.deepEqual(state(after), [[1, 'Cache', OTHER, null, 'changed']]);
});

test('a null answer clears the question', () => {
    /* Given */
    const answered = answerAt(startAnswering(round(q(1, 'Cache'))), 0, YES);

    /* When */
    const after = answerAt(answered, 0, null);

    /* Then */
    assert.equal(after.questions[0].answer, null);
});

test('an answer to a place the round does not have changes nothing', () => {
    /* Given */
    const answering = startAnswering(round(q(1, 'Cache')));

    /* When */
    const after = answerAt(answering, 3, YES);

    /* Then */
    assert.equal(after, answering);
});

// ── Matching ──

test('questions match by number and title first', () => {
    /* Given */
    const from = [q(1, 'Cache'), q(2, 'Cache')];
    const to = [q(2, 'Cache'), q(1, 'Cache')];

    /* When */
    const matches = matchQuestions(from, to);

    /* Then */
    assert.deepEqual(matches, [1, 0]);
});

test('numbers that restart across a revision still match by title', () => {
    /* Given */
    const from = [q(1, 'Cache'), q(2, 'Retry'), q(3, 'Logging')];
    const to = [q(1, 'Retry'), q(2, 'Logging')];

    /* When */
    const matches = matchQuestions(from, to);

    /* Then */
    assert.deepEqual(matches, [1, 2]);
});

test('titles match with case, punctuation, symbols and spacing aside', () => {
    /* Given */
    const from = [q(1, 'Keep the **old** API?')];
    const to = [q(1, 'keep  the old `API`')];

    /* When */
    const matches = matchQuestions(from, to);

    /* Then */
    assert.deepEqual(matches, [0]);
});

test('a reused number with a new title is a new question', () => {
    /* Given */
    const from = [q(1, 'Cache'), q(2, 'Retry')];
    const to = [q(1, 'Cache'), q(2, 'Rate limits')];

    /* When */
    const matches = matchQuestions(from, to);

    /* Then */
    assert.deepEqual(matches, [0, null]);
});

test('an old question matches at most one new one', () => {
    /* Given */
    const from = [q(1, 'Cache')];
    const to = [q(1, 'Cache'), q(2, 'Cache')];

    /* When */
    const matches = matchQuestions(from, to);

    /* Then */
    assert.deepEqual(matches, [0, null]);
});

// ── Revising ──

test('an unchanged question keeps its answer, set-aside answer and mark, whitespace aside', () => {
    /* Given */
    const first = answerAt(startAnswering(round(q(1, 'Cache'), q(2, 'Retry'))), 0, YES);
    const second = answerAt(revise(first, round(q(1, 'Cache'), q(2, 'Retry', 'Changed.'))), 1, NOTED);
    const withAside = revise(second, round(q(1, 'Cache'), q(2, 'Retry', 'Changed again.')));

    /* When */
    const third = revise(withAside, round(q(1, 'Cache', '  Why   Cache.\n'), q(2, 'Retry', 'Changed again.')));

    /* Then */
    assert.deepEqual(state(third), [
        [1, 'Cache', YES, null, null],
        [2, 'Retry', null, NOTED, 'changed'],
    ]);
    assert.equal(third.revision, 3);
});

test('a changed question is marked and its answer set aside', () => {
    /* Given */
    const answering = answerAt(startAnswering(round(q(1, 'Cache'), q(2, 'Retry'))), 1, OTHER);

    /* When */
    const revised = revise(answering, round(q(1, 'Cache'), q(2, 'Retry', 'Why Retry.', 'Retry twice.')));

    /* Then */
    assert.deepEqual(state(revised), [
        [1, 'Cache', null, null, null],
        [2, 'Retry', null, OTHER, 'changed'],
    ]);
    assert.equal(revised.revision, 1);
});

test('a changed question without an answer keeps what was set aside before', () => {
    /* Given */
    const answered = answerAt(startAnswering(round(q(1, 'Cache'))), 0, YES);
    const once = revise(answered, round(q(1, 'Cache', 'Second.')));

    /* When */
    const twice = revise(once, round(q(1, 'Cache', 'Third.')));

    /* Then */
    assert.deepEqual(state(twice), [[1, 'Cache', null, YES, 'changed']]);
});

test('a question no older one matches is new', () => {
    /* Given */
    const answering = startAnswering(round(q(1, 'Cache')));

    /* When */
    const revised = revise(answering, round(q(1, 'Cache'), q(2, 'Retry')));

    /* Then */
    assert.deepEqual(state(revised), [
        [1, 'Cache', null, null, null],
        [2, 'Retry', null, null, 'new'],
    ]);
});

test('a question that was new and then changes stays new, its answer set aside', () => {
    /* Given */
    const added = revise(startAnswering(round(q(1, 'Cache'))), round(q(1, 'Cache'), q(2, 'Retry')));
    const answered = answerAt(added, 1, YES);

    /* When */
    const revised = revise(answered, round(q(1, 'Cache'), q(2, 'Retry', 'Reworded.')));

    /* Then */
    assert.deepEqual(state(revised)[1], [2, 'Retry', null, YES, 'new']);
});

test('a question a revision leaves out is dropped with its answer and counted', () => {
    /* Given */
    const answering = answerAt(startAnswering(round(q(1, 'Cache'), q(2, 'Retry'), q(3, 'Logging'))), 1, YES);

    /* When */
    const revised = revise(answering, round(q(1, 'Cache'), q(2, 'Logging')));

    /* Then */
    assert.deepEqual(state(revised), [
        [1, 'Cache', null, null, null],
        [2, 'Logging', null, null, null],
    ]);
    assert.equal(revised.dropped, 1);
});

test('dropped questions add up across revisions', () => {
    /* Given */
    const once = revise(
        startAnswering(round(q(1, 'Cache'), q(2, 'Retry'), q(3, 'Logging'))),
        round(q(1, 'Cache'), q(2, 'Retry')),
    );

    /* When */
    const twice = revise(once, round(q(1, 'Cache')));

    /* Then */
    assert.equal(twice.dropped, 2);
});

test('a question added by a revision and dropped by the next is not counted', () => {
    /* Given */
    const added = revise(startAnswering(round(q(1, 'Cache'))), round(q(1, 'Cache'), q(2, 'Retry')));

    /* When */
    const dropped = revise(added, round(q(1, 'Cache')));

    /* Then */
    assert.equal(dropped.dropped, 0);
    assert.deepEqual(revisionCounts(dropped), {changed: 0, added: 0, dropped: 0});
});

test('the revision banner counts changed, new and dropped questions', () => {
    /* Given */
    const answering = startAnswering(round(q(1, 'Cache'), q(2, 'Retry'), q(3, 'Logging')));

    /* When */
    const revised = revise(
        answering,
        round(q(1, 'Cache', 'Reworded.'), q(2, 'Retry'), q(3, 'Metrics'), q(4, 'Alerts')),
    );

    /* Then */
    assert.deepEqual(revisionCounts(revised), {changed: 1, added: 2, dropped: 1});
});

test('revising leaves the drafts it came from unchanged', () => {
    /* Given */
    const answering = answerAt(startAnswering(round(q(1, 'Cache'))), 0, YES);

    /* When */
    revise(answering, round(q(1, 'Cache', 'Reworded.')));

    /* Then */
    assert.deepEqual(state(answering), [[1, 'Cache', YES, null, null]]);
    assert.equal(answering.revision, 0);
});

// ── Answers given against an older revision ──

test('a question of an older revision is carried to where it went, same or changed, or nowhere', () => {
    /* Given */
    const from = round(q(1, 'Cache'), q(2, 'Retry'), q(3, 'Logging'));
    const to = round(q(1, 'Retry', 'Why Retry.', 'Retry twice.'), q(2, 'Cache'));

    /* When */
    const carried = [carry(from, 0, to), carry(from, 1, to), carry(from, 2, to)];

    /* Then */
    assert.deepEqual(carried, [{place: 1, same: true}, {place: 0, same: false}, null]);
});

test('an answer given against an older revision lands on the unchanged question it became', () => {
    /* Given */
    const first = round(q(1, 'Cache'), q(2, 'Retry'));
    const revised = revise(startAnswering(first), round(q(1, 'Retry'), q(2, 'Cache')));

    /* When */
    const after = answerAgainst(revised, first, 0, YES);

    /* Then */
    assert.deepEqual(state(after), [
        [1, 'Retry', null, null, null],
        [2, 'Cache', YES, null, null],
    ]);
});

test('an answer given against an older revision onto a changed question lands in set-aside', () => {
    /* Given */
    const first = round(q(1, 'Cache'), q(2, 'Retry'));
    const revised = revise(startAnswering(first), round(q(1, 'Cache'), q(2, 'Retry', 'Reworded.')));

    /* When */
    const after = answerAgainst(revised, first, 1, OTHER);

    /* Then */
    assert.deepEqual(state(after)[1], [2, 'Retry', null, OTHER, 'changed']);
});

test('an answer given against an older revision to a dropped question is let go', () => {
    /* Given */
    const first = round(q(1, 'Cache'), q(2, 'Retry'));
    const revised = revise(startAnswering(first), round(q(1, 'Cache')));

    /* When */
    const after = answerAgainst(revised, first, 1, YES);

    /* Then */
    assert.equal(after, revised);
});
