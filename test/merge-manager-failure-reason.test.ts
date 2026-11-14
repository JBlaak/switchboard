/** Why a Merge manager call failed: main's refusal, or the error a call that threw came back with. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {failureReason} from '../src/renderer/ui/merge-manager/failure-reason';

test('a refusal from main says its reason', () => {
    /* Given */
    const answer = {ok: false, reason: 'Mark it ready for review first'};

    /* When */
    const text = failureReason(answer, 'fallback');

    /* Then */
    assert.equal(text, 'Mark it ready for review first');
});

test('a call that threw says the error the IPC envelope carries', () => {
    /* Given: the VM that merges could not be reached */
    const answer = {ok: false, error: 'ubuntu@10.10.0.24: Permission denied (publickey).'};

    /* When */
    const text = failureReason(answer, 'fallback');

    /* Then */
    assert.equal(text, 'ubuntu@10.10.0.24: Permission denied (publickey).');
});

test('an answer that says nothing falls back rather than saying undefined', () => {
    /* Given */
    const answers = [{ok: false}, {ok: false, reason: ''}, undefined, null];

    /* When */
    const texts = answers.map((answer) => failureReason(answer, 'GitHub did not say why'));

    /* Then */
    assert.deepEqual(texts, Array(4).fill('GitHub did not say why'));
});
