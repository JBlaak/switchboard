import {test} from 'node:test';
import assert from 'node:assert/strict';

import {copyDir, copyFolderName, isConfigCandidate, isKeyFile, tickedByDefault} from '../src/domain/agent/handoff';

/**
 * Which ignored files a hand-off offers and ticks, and where the copy goes
 * (#276 stage 2): the rules, without git.
 */

test('config-like ignored files are offered', () => {
    /* Given */
    const paths = [
        '.env',
        '.env.local',
        '.env.production',
        'app/.env',
        'settings.local',
        'local.properties',
        'android/local.properties',
        '.npmrc',
        'secrets.json',
        'config/database.local.yml',
        'certs/dev.pem',
        'server.key',
    ];

    /* When */
    const offered = paths.filter(isConfigCandidate);

    /* Then */
    assert.deepEqual(offered, paths);
});

test('dependency, build and cache folders and their contents are never offered', () => {
    /* Given */
    const paths = [
        'node_modules/',
        'node_modules/pkg/.env',
        'app/node_modules/x/.npmrc',
        '.gradle/local.properties',
        'build/.env',
        'dist/secrets.json',
        '.next/.env',
        'target/local.properties',
        'vendor/x/.env',
        '.venv/.env',
        '__pycache__/secrets.py',
        '.cache/.env',
    ];

    /* When */
    const offered = paths.filter(isConfigCandidate);

    /* Then */
    assert.deepEqual(offered, []);
});

test('directories, OS litter and ordinary ignored files are never offered', () => {
    /* Given */
    const paths = ['config/', '.env/', '.DS_Store', 'app/.DS_Store', 'debug.log', 'notes.txt', 'config/app.json'];

    /* When */
    const offered = paths.filter(isConfigCandidate);

    /* Then */
    assert.deepEqual(offered, []);
});

test('*.local.* counts only directly in a config folder', () => {
    /* When */
    const inConfig = isConfigCandidate('config/app.local.json');
    const elsewhere = isConfigCandidate('src/app.local.json');

    /* Then */
    assert.equal(inConfig, true);
    assert.equal(elsewhere, false);
});

test('keys are offered but never ticked on a first hand-off', () => {
    /* When */
    const key = tickedByDefault('certs/dev.pem', null);
    const env = tickedByDefault('.env', null);

    /* Then */
    assert.equal(isKeyFile('certs/dev.pem'), true);
    assert.equal(isKeyFile('server.KEY'), true);
    assert.equal(key, false);
    assert.equal(env, true);
});

test('a remembered choice decides exactly what is ticked, keys included', () => {
    /* Given */
    const remembered = ['certs/dev.pem'];

    /* When */
    const key = tickedByDefault('certs/dev.pem', remembered);
    const env = tickedByDefault('.env', remembered);

    /* Then */
    assert.equal(key, true);
    assert.equal(env, false);
});

test('an empty remembered choice ticks nothing', () => {
    /* When */
    const ticked = tickedByDefault('.env', []);

    /* Then */
    assert.equal(ticked, false);
});

test("the copy's folder is the repository's basename as one safe segment", () => {
    /* When */
    const names = [
        copyFolderName('/Users/joris/Development/switchboard'),
        copyFolderName('/Users/joris/Development/switchboard/'),
        copyFolderName('/Users/joris/My Project (old)'),
        copyFolderName('/Users/joris/.hidden'),
        copyFolderName('/Users/joris/Café'),
        copyFolderName('/Users/joris/--x'),
        copyFolderName('/'),
        copyFolderName('/Users/joris/$(rm -rf ~)'),
    ];

    /* Then */
    assert.deepEqual(names, [
        'switchboard',
        'switchboard',
        'My-Project-old',
        'hidden',
        'Cafe',
        'x',
        'project',
        'rm-rf',
    ]);
});

test("the copy's directory is the base folder and the name, ~ kept", () => {
    /* When */
    const dirs = [
        copyDir('~/projects', 'site'),
        copyDir('/srv/work/', 'site'),
        copyDir('', 'site'),
        copyDir(null, 'site'),
    ];

    /* Then */
    assert.deepEqual(dirs, ['~/projects/site', '/srv/work/site', '~/projects/site', '~/projects/site']);
});
