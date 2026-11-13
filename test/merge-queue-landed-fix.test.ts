/**
 * A failed queue entry whose PR is landed (#437): the Merge manager's fix
 * errand has it, so the row offers Open errand, or Open and Try again.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {landedFixStatus} from '../src/renderer/ui/project-page/merge-queue-view';
import {mergeManagerState} from '../src/domain/merge-manager/landed';
import {REPO, landedPr} from './support/merge-manager-fixtures';

test('a landed PR at Fixing shows its errand; one whose errand stopped needs you', () => {
    /* Given */
    const state = mergeManagerState(
        [
            landedPr(7, 10, 'queue', {kind: 'fixing', cause: 'conflict'}, {errand: 's7'}),
            landedPr(8, 9, 'queue', {kind: 'needsYou', reason: {kind: 'errand-stopped'}}, {errand: 's8'}),
            landedPr(9, 8, 'queue', {kind: 'needsYou', reason: {kind: 'changes-requested'}}),
        ],
        new Map(),
    );

    /* When */
    const statuses = [[7], [8], [9], [10]].map((numbers) => landedFixStatus(state, REPO.toUpperCase(), numbers));

    /* Then */
    assert.deepEqual(statuses, [
        {kind: 'fixing', number: 7, sessionId: 's7'},
        {kind: 'needs-you', number: 8, sessionId: 's8'},
        null,
        null,
    ]);
});
