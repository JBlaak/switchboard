/**
 * Files dropped on a terminal (#276 stage 5): a local session pastes their
 * paths as before; a VM session uploads them first, with a note, and types
 * the VM's paths, quoted the same way, or shows the error and types nothing.
 * Also the note's own state.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {afterUpload, dropPlan, uploadingNote} from '../src/renderer/features/terminal/dropped-files';
import {dropUploadReducer, initialDropUploadState} from '../src/renderer/state/drop-upload-slice';
import type {RendererEvent} from '../src/renderer/state/events';
import type {DropUploadState} from '../src/renderer/state/drop-upload-slice';

// ── Upload or paste ──

test('a drop on a local session pastes the quoted local paths, as before', () => {
    /* When */
    const plan = dropPlan(['/Users/me/a.png', "/Users/me/it's here.txt"], false);

    /* Then */
    assert.deepEqual(plan, {kind: 'paste', text: "'/Users/me/a.png' '/Users/me/it'\\''s here.txt'"});
});

test('a drop on a VM session uploads the files first, with a note saying how many', () => {
    /* When */
    const plan = dropPlan(['/Users/me/a.png', '/Users/me/b.png'], true);

    /* Then */
    assert.deepEqual(plan, {
        kind: 'upload',
        localPaths: ['/Users/me/a.png', '/Users/me/b.png'],
        note: 'Uploading 2 files to the VM…',
    });
});

test('one file’s note says file, not files', () => {
    /* When */
    const note = uploadingNote(1);

    /* Then */
    assert.equal(note, 'Uploading 1 file to the VM…');
});

test('a drop with no paths does nothing', () => {
    /* When */
    const plans = [dropPlan([], true), dropPlan([''], false)];

    /* Then */
    assert.deepEqual(plans, [null, null]);
});

// ── After the upload ──

test('an upload types the VM’s paths, quoted as a local drop’s are', () => {
    /* When */
    const outcome = afterUpload({ok: true, paths: ['/tmp/sb-drop/a b.png', '/tmp/sb-drop/c.png']});

    /* Then */
    assert.deepEqual(outcome, {kind: 'type', text: "'/tmp/sb-drop/a b.png' '/tmp/sb-drop/c.png'"});
});

test('a failed upload shows its error and types nothing', () => {
    /* When */
    const outcome = afterUpload({ok: false, error: 'a.mov is larger than 64 MB'});

    /* Then */
    assert.deepEqual(outcome, {kind: 'error', message: 'Couldn’t upload to the VM: a.mov is larger than 64 MB'});
});

test('an answer main didn’t shape, or one with no paths, is an error too', () => {
    /* When */
    const outcomes = [afterUpload(undefined), afterUpload({ok: true, paths: []})];

    /* Then */
    assert.deepEqual(outcomes, [
        {kind: 'error', message: 'Couldn’t upload to the VM'},
        {kind: 'error', message: 'Couldn’t upload to the VM'},
    ]);
});

// ── The note ──

function run(...events: RendererEvent[]): DropUploadState {
    return events.reduce((state, event) => dropUploadReducer(state, event), initialDropUploadState);
}

test('the note shows while the files upload and goes once they have', () => {
    /* When */
    const uploading = run({type: 'dropUploadStarted', id: 1, text: 'Uploading 2 files to the VM…'});
    const done = dropUploadReducer(uploading, {type: 'dropUploadFinished', id: 1});

    /* Then */
    assert.deepEqual(uploading.upload, {id: 1, phase: 'uploading', text: 'Uploading 2 files to the VM…'});
    assert.equal(done.upload, null);
});

test('a failed upload leaves its error up until it is put away', () => {
    /* When */
    const failed = run(
        {type: 'dropUploadStarted', id: 1, text: 'Uploading 1 file to the VM…'},
        {type: 'dropUploadFailed', id: 1, error: 'Couldn’t upload to the VM'},
    );
    const closed = dropUploadReducer(failed, {type: 'dropUploadClosed', id: 1});

    /* Then */
    assert.deepEqual(failed.upload, {id: 1, phase: 'failed', text: 'Couldn’t upload to the VM'});
    assert.equal(closed.upload, null);
});

test('a newer drop replaces the note, and the older one’s end leaves it alone', () => {
    /* When */
    const state = run(
        {type: 'dropUploadStarted', id: 1, text: 'Uploading 1 file to the VM…'},
        {type: 'dropUploadStarted', id: 2, text: 'Uploading 3 files to the VM…'},
        {type: 'dropUploadFailed', id: 1, error: 'old'},
        {type: 'dropUploadFinished', id: 1},
    );

    /* Then */
    assert.deepEqual(state.upload, {id: 2, phase: 'uploading', text: 'Uploading 3 files to the VM…'});
});
