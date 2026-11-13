import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    BUGSNAG_SETTINGS_KEY,
    bugsnagProjectsFor,
    changeProject,
    DEFAULT_TRENDING,
    localProjectFor,
    normaliseTrending,
    projectRows,
    renameFromListed,
    resolveBugsnagSettings,
} from '../src/domain/bugsnag/connection';
import type {BugsnagSettings} from '../src/domain/bugsnag/connection';
import type {BugsnagProject} from '../src/domain/bugsnag/model';

const EMPTY: BugsnagSettings = {projects: [], trending: DEFAULT_TRENDING};

function listed(id: string, name: string): BugsnagProject {
    return {id, name, slug: id, htmlUrl: null};
}

test('nothing stored resolves to no projects and the default thresholds', () => {
    /* When */
    const settings = resolveBugsnagSettings({});

    /* Then */
    assert.deepEqual(settings, {projects: [], trending: {multiplier: 3, minEvents: 20}});
});

test('opting a project in stores it, unlinked', () => {
    /* When */
    const settings = changeProject(EMPTY, 'api', {optedIn: true}, 'Connect API');

    /* Then */
    assert.deepEqual(settings.projects, [{id: 'api', name: 'Connect API', optedIn: true, localProject: null}]);
});

test('one local project can link several Bugsnag projects', () => {
    /* Given */
    const api = changeProject(EMPTY, 'api', {localProject: '/code/connect'}, 'Connect API');

    /* When */
    const both = changeProject(api, 'web', {localProject: '/code/connect'}, 'Connect Web');

    /* Then */
    assert.deepEqual(
        bugsnagProjectsFor(both, '/code/connect').map((project) => project.id),
        ['api', 'web'],
    );
});

test('linking a Bugsnag project elsewhere moves its one link instead of adding a second', () => {
    /* Given */
    const settings = changeProject(EMPTY, 'api', {optedIn: true, localProject: '/code/connect'});

    /* When */
    const moved = changeProject(settings, 'api', {localProject: '/code/studio'});

    /* Then */
    assert.equal(moved.projects.length, 1);
    assert.equal(localProjectFor(moved, 'api'), '/code/studio');
    assert.deepEqual(bugsnagProjectsFor(moved, '/code/connect'), []);
    assert.equal(moved.projects[0].optedIn, true);
});

test('linking to null unlinks', () => {
    /* Given */
    const settings = changeProject(EMPTY, 'api', {localProject: '/code/connect'});

    /* When */
    const unlinked = changeProject(settings, 'api', {localProject: null});

    /* Then */
    assert.equal(localProjectFor(unlinked, 'api'), null);
});

test('a stored blob listing a project twice keeps only its first entry', () => {
    /* Given */
    const global = {
        [BUGSNAG_SETTINGS_KEY]: {
            projects: [
                {id: 'api', name: 'Connect API', optedIn: true, localProject: '/code/connect'},
                {id: 'api', name: 'Connect API', optedIn: true, localProject: '/code/studio'},
                {name: 'no id'},
            ],
        },
    };

    /* When */
    const settings = resolveBugsnagSettings(global);

    /* Then */
    assert.deepEqual(settings.projects, [
        {id: 'api', name: 'Connect API', optedIn: true, localProject: '/code/connect'},
    ]);
});

test('thresholds are clamped and rounded, and nonsense falls back to the defaults', () => {
    /* When */
    const clamped = normaliseTrending({multiplier: 0.2, minEvents: 12.6});
    const nonsense = normaliseTrending({multiplier: 'lots', minEvents: null});

    /* Then */
    assert.deepEqual(clamped, {multiplier: 1, minEvents: 13});
    assert.deepEqual(nonsense, {multiplier: 3, minEvents: 20});
});

test('the Settings list shows every visible project with its choices, then stored ones no longer visible', () => {
    /* Given */
    let settings = changeProject(EMPTY, 'api', {optedIn: true, localProject: '/code/connect'}, 'Connect API');
    settings = changeProject(settings, 'gone', {optedIn: true}, 'Old app');
    settings = changeProject(settings, 'dropped', {optedIn: false}, 'Never used');

    /* When */
    const rows = projectRows(settings, [listed('web', 'Connect Web'), listed('api', 'Connect API')]);

    /* Then */
    assert.deepEqual(rows, [
        {id: 'web', name: 'Connect Web', optedIn: false, localProject: null, missing: false},
        {id: 'api', name: 'Connect API', optedIn: true, localProject: '/code/connect', missing: false},
        {id: 'gone', name: 'Old app', optedIn: true, localProject: null, missing: true},
    ]);
});

test('a renamed project in Bugsnag is renamed in the stored settings', () => {
    /* Given */
    const settings = changeProject(EMPTY, 'api', {optedIn: true}, 'Connect API');

    /* When */
    const renamed = renameFromListed(settings, [listed('api', 'Connect API - Production')]);

    /* Then */
    assert.equal(renamed.projects[0].name, 'Connect API - Production');
});
