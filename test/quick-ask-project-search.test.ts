/**
 * Quick Ask's project search: a proper match on the folder name, or nothing,
 * so a sentence for Patch falls through.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MAX_PROJECT_HITS, searchProjects} from '../src/domain/ask/project-search';
import type {ProjectHit} from '../src/domain/ask/project-search';

const hit = (folder: string): ProjectHit => ({projectPath: `/dev/${folder}`, folder});

const PROJECTS = [hit('cityrow-ios'), hit('switchboard'), hit('waterrower-ios'), hit('Patch')];

const folders = (hits: ProjectHit[]): string[] => hits.map((h) => h.folder);

test('an empty query matches nothing', () => {
    /* When */
    const hits = searchProjects(PROJECTS, '   ');

    /* Then */
    assert.deepEqual(hits, []);
});

test('a folder that starts with the query matches, case left out', () => {
    /* When */
    const hits = searchProjects(PROJECTS, 'SwitchB');

    /* Then */
    assert.deepEqual(folders(hits), ['switchboard']);
});

test('spaces and dashes are left out on both sides', () => {
    /* When */
    const hits = searchProjects(PROJECTS, 'water rower');

    /* Then */
    assert.deepEqual(folders(hits), ['waterrower-ios']);
});

test('folders that start with the query come before those holding it further in, each in the given order', () => {
    /* Given */
    const projects = [hit('cityrow-ios'), hit('rowing'), hit('waterrower-ios'), hit('rower')];

    /* When */
    const hits = searchProjects(projects, 'row');

    /* Then */
    assert.deepEqual(folders(hits), ['rowing', 'rower', 'cityrow-ios', 'waterrower-ios']);
});

test('a sentence for Patch matches nothing, even naming a project', () => {
    /* When */
    const hits = searchProjects(PROJECTS, 'fix the login in switchboard');

    /* Then */
    assert.deepEqual(hits, []);
});

test('the list stops at its limit', () => {
    /* Given */
    const projects = Array.from({length: MAX_PROJECT_HITS + 3}, (_, i) => hit(`app-${i}`));

    /* When */
    const hits = searchProjects(projects, 'app');

    /* Then */
    assert.equal(hits.length, MAX_PROJECT_HITS);
});
