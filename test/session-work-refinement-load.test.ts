import {beforeEach, test} from 'node:test';
import assert from 'node:assert/strict';

import {
    peekRefinement,
    refinable,
    requestRefinement,
    resetRefinements,
    subscribeRefinements,
} from '../src/renderer/ui/session-work/refinement-load';
import type {RefinementRequest} from '../src/renderer/ui/session-work/refinement-load';
import {refinementPill} from '../src/renderer/ui/session-work/describe';
import type {FileDiff} from '../src/domain/session-work/model';
import type {FileRefinement} from '../src/domain/session-work/refinement';

const REQUEST: RefinementRequest = {sessionId: 's1', itemId: 'dirty', path: 'src/a.ts'};
const REFINEMENT: FileRefinement = {summary: 'whitespace_only', before: {}, after: {}};

function file(overrides: Partial<FileDiff> = {}): FileDiff {
    return {
        path: 'src/a.ts',
        status: 'modified',
        additions: 1,
        deletions: 1,
        hunks: [{oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, section: '', lines: []}],
        binary: false,
        ...overrides,
    };
}

/** A fetch that counts its calls and answers what it is given. */
function fakeFetch(answer: () => Promise<FileRefinement | null>): {
    fetch: (request: RefinementRequest) => Promise<FileRefinement | null>;
    calls: RefinementRequest[];
} {
    const calls: RefinementRequest[] = [];
    return {
        calls,
        fetch: (request) => {
            calls.push(request);
            return answer();
        },
    };
}

const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
    resetRefinements();
});

test('refinable: only a modified or renamed text file with lines, drawn as lines', () => {
    /* Given */
    const cases: Array<[FileDiff, boolean, boolean, string]> = [
        [file(), false, true, 'modified'],
        [file({status: 'renamed', oldPath: 'src/b.ts'}), false, true, 'renamed'],
        [file({status: 'added'}), false, false, 'added'],
        [file({status: 'deleted'}), false, false, 'deleted'],
        [file({status: 'copied'}), false, false, 'copied'],
        [file({binary: true, hunks: []}), false, false, 'binary'],
        [file({hunks: []}), false, false, 'no hunks'],
        [file(), true, false, 'an image card'],
    ];

    for (const [changed, imageCard, expected, why] of cases) {
        /* When */
        const answer = refinable(changed, imageCard);

        /* Then */
        assert.equal(answer, expected, why);
    }
});

test('a refinement is asked of main once per load key, and kept once it lands', async () => {
    /* Given */
    const {fetch, calls} = fakeFetch(async () => REFINEMENT);
    let heard = 0;
    const unsubscribe = subscribeRefinements(() => heard++);

    /* When */
    requestRefinement(REQUEST, 'k1', fetch);
    const before = peekRefinement(REQUEST, 'k1');
    requestRefinement(REQUEST, 'k1', fetch);
    await settled();
    requestRefinement(REQUEST, 'k1', fetch);
    unsubscribe();

    /* Then */
    assert.equal(before, null, 'nothing until main answers');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], REQUEST);
    assert.equal(peekRefinement(REQUEST, 'k1'), REFINEMENT);
    assert.equal(heard, 1);
});

test('a null answer is kept too, and not asked again', async () => {
    /* Given */
    const {fetch, calls} = fakeFetch(async () => null);

    /* When */
    requestRefinement(REQUEST, 'k1', fetch);
    await settled();
    requestRefinement(REQUEST, 'k1', fetch);

    /* Then */
    assert.equal(calls.length, 1);
    assert.equal(peekRefinement(REQUEST, 'k1'), null);
});

test('an error from main reads as no refinement, silently', async () => {
    /* Given */
    const {fetch, calls} = fakeFetch(() => Promise.reject(new Error('omnidiff crashed')));

    /* When */
    requestRefinement(REQUEST, 'k1', fetch);
    await settled();
    requestRefinement(REQUEST, 'k1', fetch);

    /* Then */
    assert.equal(calls.length, 1);
    assert.equal(peekRefinement(REQUEST, 'k1'), null);
});

test('a new load key for the item asks again and drops the answers for the old one', async () => {
    /* Given */
    const {fetch, calls} = fakeFetch(async () => REFINEMENT);
    requestRefinement(REQUEST, 'k1', fetch);
    await settled();

    /* When */
    requestRefinement(REQUEST, 'k2', fetch);
    await settled();

    /* Then */
    assert.equal(calls.length, 2);
    assert.equal(peekRefinement(REQUEST, 'k1'), null, 'the old answer is gone');
    assert.equal(peekRefinement(REQUEST, 'k2'), REFINEMENT);
});

test('an answer that lands after its load key was replaced is not kept', async () => {
    /* Given */
    let answerOld: (answer: FileRefinement | null) => void = () => {};
    const slow = (): Promise<FileRefinement | null> =>
        new Promise((resolve) => {
            answerOld = resolve;
        });
    requestRefinement(REQUEST, 'k1', slow);

    /* When */
    requestRefinement(REQUEST, 'k2', async () => null);
    answerOld(REFINEMENT);
    await settled();

    /* Then */
    assert.equal(peekRefinement(REQUEST, 'k1'), null);
});

test("a file's refinement pill: only for whitespace, comments and moves", () => {
    /* Given */
    const cases: Array<[FileRefinement['summary'] | undefined, ReturnType<typeof refinementPill>]> = [
        ['whitespace_only', {label: 'Whitespace only', tone: 'grey'}],
        ['comment_only', {label: 'Comments only', tone: 'grey'}],
        ['refactor_moved_only', {label: 'Moved only', tone: 'grey'}],
        ['no_changes', null],
        ['new_file', null],
        ['deleted_file', null],
        [null, null],
        [undefined, null],
    ];

    for (const [summary, expected] of cases) {
        /* When */
        const pill = refinementPill(summary);

        /* Then */
        assert.deepEqual(pill, expected, String(summary));
    }
});
