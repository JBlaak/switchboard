/**
 * The face Patch wears as the Quick Ask mark, phase by phase.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {patchMarkFace} from '../src/renderer/quick-ask/patch-mark';

test('Patch smiles while you type, and again once a capture is undone', () => {
    /* Given */
    const phases = ['editing', 'undone'] as const;

    /* When */
    const faces = phases.map(patchMarkFace);

    /* Then */
    assert.deepEqual(faces, ['smile', 'smile']);
});

test('Patch looks up while it routes, saves or takes a capture back', () => {
    /* Given */
    const phases = ['waiting', 'saving', 'undoing'] as const;

    /* When */
    const faces = phases.map(patchMarkFace);

    /* Then */
    assert.deepEqual(faces, ['thinking', 'thinking', 'thinking']);
});

test('Patch looks down at the choices when it is not sure', () => {
    /* When */
    const face = patchMarkFace('choosing');

    /* Then */
    assert.equal(face, 'unsure');
});

test('Patch beams once a session started or a capture saved', () => {
    /* Given */
    const phases = ['started', 'saved'] as const;

    /* When */
    const faces = phases.map(patchMarkFace);

    /* Then */
    assert.deepEqual(faces, ['happy', 'happy']);
});
