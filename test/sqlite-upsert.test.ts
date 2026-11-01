import test from 'node:test';
import assert from 'node:assert/strict';

import {upsertSql} from '../src/infrastructure/sqlite/support/upsert';

test('an upsert of one column inserts it beside the key and overwrites only that column', () => {
    /* Given */
    const table = 'session_meta';

    /* When */
    const sql = upsertSql(table, 'sessionId', ['name']);

    /* Then */
    assert.equal(
        sql,
        'INSERT INTO session_meta (sessionId, name) VALUES (?, ?) ON CONFLICT(sessionId) DO UPDATE SET name = excluded.name',
    );
});

test('an upsert of several columns binds the key first, then the columns in the order given', () => {
    /* Given */
    const columns = ['projectPath', 'indexMtimeMs'];

    /* When */
    const sql = upsertSql('cache_meta', 'folder', columns);

    /* Then */
    assert.equal(
        sql,
        'INSERT INTO cache_meta (folder, projectPath, indexMtimeMs) VALUES (?, ?, ?) ' +
            'ON CONFLICT(folder) DO UPDATE SET projectPath = excluded.projectPath, indexMtimeMs = excluded.indexMtimeMs',
    );
});
