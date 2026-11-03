/**
 * VM hosts in the renderer's store (#276): which projects are VM projects, an
 * install's progress, failure and retry, the setup checks, and the host
 * settings with a host that can't be reached.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initialRendererState, rootReducer} from '../src/renderer/state/root';
import {hostViewIn, isVmProjectIn} from '../src/renderer/state/agent-host-slice';
import type {RendererEvent} from '../src/renderer/state/events';
import type {RendererState} from '../src/renderer/state/root';
import type {HostSettings} from '../src/domain/agent/protocol';

const BOX = 'ssh://me@box/app';
const SETTINGS: HostSettings = {instructions: 'Install what you need.', copyConfig: true, baseFolder: '~/projects'};

function run(state: RendererState, ...events: RendererEvent[]): RendererState {
    return events.reduce((s, e) => rootReducer(Object.freeze(s), e), state);
}

function host(state: RendererState) {
    return hostViewIn(state.agentHost, BOX);
}

// ── VM projects ──

test('the project list says which projects are VM projects', () => {
    /* When */
    const state = run(initialRendererState(), {type: 'agentProjectsLoaded', projectPaths: ['ssh://me@vm/app']});

    /* Then */
    assert.equal(isVmProjectIn(state.agentHost, 'ssh://me@vm/app'), true);
    assert.equal(isVmProjectIn(state.agentHost, BOX), false);
});

test('the same list again changes nothing', () => {
    /* Given */
    const before = run(initialRendererState(), {type: 'agentProjectsLoaded', projectPaths: ['ssh://me@vm/app']});

    /* When */
    const after = run(before, {type: 'agentProjectsLoaded', projectPaths: ['ssh://me@vm/app']});

    /* Then */
    assert.equal(after, before);
});

// ── Install ──

test('an install runs with its progress lines, in order', () => {
    /* When */
    const state = run(
        initialRendererState(),
        {type: 'agentInstallStarted', projectPath: BOX},
        {type: 'agentInstallProgress', projectPath: BOX, line: 'Checking systemd'},
        {type: 'agentInstallProgress', projectPath: BOX, line: 'Uploading the agent'},
    );

    /* Then */
    assert.deepEqual(host(state).install, {phase: 'running', lines: ['Checking systemd', 'Uploading the agent']});
});

test('progress for a project that is not installing is left out', () => {
    /* Given */
    const before = initialRendererState();

    /* When */
    const after = run(before, {type: 'agentInstallProgress', projectPath: BOX, line: 'stray'});

    /* Then */
    assert.equal(after, before);
});

test('a failed install keeps its lines and says why', () => {
    /* When */
    const state = run(
        initialRendererState(),
        {type: 'agentInstallStarted', projectPath: BOX},
        {type: 'agentInstallProgress', projectPath: BOX, line: 'Checking systemd'},
        {type: 'agentInstallFinished', projectPath: BOX, ok: false, error: 'This host has no systemd.'},
    );

    /* Then */
    assert.deepEqual(host(state).install, {
        phase: 'failed',
        lines: ['Checking systemd'],
        error: 'This host has no systemd.',
    });
    assert.equal(isVmProjectIn(state.agentHost, BOX), false);
});

test('Retry starts the install again with no lines', () => {
    /* Given */
    const failed = run(
        initialRendererState(),
        {type: 'agentInstallStarted', projectPath: BOX},
        {type: 'agentInstallProgress', projectPath: BOX, line: 'Checking systemd'},
        {type: 'agentInstallFinished', projectPath: BOX, ok: false, error: 'No systemd.'},
    );

    /* When */
    const state = run(failed, {type: 'agentInstallStarted', projectPath: BOX});

    /* Then */
    assert.deepEqual(host(state).install, {phase: 'running', lines: []});
});

test('a finished install makes the project a VM project, and the next list keeps it one', () => {
    /* Given */
    const installed = run(
        initialRendererState(),
        {type: 'agentInstallStarted', projectPath: BOX},
        {type: 'agentInstallFinished', projectPath: BOX, ok: true},
    );

    /* When */
    const reloaded = run(installed, {type: 'agentProjectsLoaded', projectPaths: []});

    /* Then */
    assert.equal(host(installed).install.phase, 'done');
    assert.equal(isVmProjectIn(installed.agentHost, BOX), true);
    assert.equal(isVmProjectIn(reloaded.agentHost, BOX), true);
});

// ── Setup checks ──

test('the checks load, and a refresh keeps them on screen until the answer', () => {
    /* Given */
    const tools = [{tool: 'git' as const, installed: true, version: '2.43.0'}];
    const loaded = run(
        initialRendererState(),
        {type: 'agentToolsRequested', projectPath: BOX},
        {type: 'agentToolsLoaded', projectPath: BOX, answer: {tools, sudo: true}},
    );

    /* When */
    const refreshing = run(loaded, {type: 'agentToolsRequested', projectPath: BOX});

    /* Then */
    assert.deepEqual(host(refreshing).tools, {phase: 'ok', tools, sudo: true});
});

test('checks a host could not answer are unreachable', () => {
    /* When */
    const state = run(
        initialRendererState(),
        {type: 'agentToolsRequested', projectPath: BOX},
        {type: 'agentToolsLoaded', projectPath: BOX, answer: null},
    );

    /* Then */
    assert.deepEqual(host(state).tools, {phase: 'unreachable'});
});

test('a setup terminal that did not open says why, until it is asked for again', () => {
    /* Given */
    const failed = run(initialRendererState(), {
        type: 'agentSetupTerminalFailed',
        projectPath: BOX,
        message: 'No link',
    });

    /* When */
    const again = run(failed, {type: 'agentSetupTerminalOpening', projectPath: BOX});

    /* Then */
    assert.equal(host(failed).setupError, 'No link');
    assert.equal(host(again).setupError, null);
});

// ── Host settings ──

test('host settings load from the host', () => {
    /* When */
    const state = run(
        initialRendererState(),
        {type: 'agentHostSettingsRequested', projectPath: BOX},
        {type: 'agentHostSettingsLoaded', projectPath: BOX, settings: SETTINGS},
    );

    /* Then */
    assert.deepEqual(host(state).settings, {phase: 'ok', settings: SETTINGS, saveError: null});
});

test('host settings a host could not answer are unreachable, not an empty form', () => {
    /* When */
    const state = run(
        initialRendererState(),
        {type: 'agentHostSettingsRequested', projectPath: BOX},
        {type: 'agentHostSettingsLoaded', projectPath: BOX, settings: null},
    );

    /* Then */
    assert.deepEqual(host(state).settings, {phase: 'unreachable'});
});

test('a save that did not land keeps what the host said, with the message', () => {
    /* Given */
    const loaded = run(initialRendererState(), {type: 'agentHostSettingsLoaded', projectPath: BOX, settings: SETTINGS});

    /* When */
    const state = run(loaded, {type: 'agentHostSettingsSaveFailed', projectPath: BOX, message: 'Couldn’t save.'});

    /* Then */
    assert.deepEqual(host(state).settings, {phase: 'ok', settings: SETTINGS, saveError: 'Couldn’t save.'});
});

test('a save that lands shows the settings the host answered and clears the message', () => {
    /* Given */
    const failed = run(
        initialRendererState(),
        {type: 'agentHostSettingsLoaded', projectPath: BOX, settings: SETTINGS},
        {type: 'agentHostSettingsSaveFailed', projectPath: BOX, message: 'Couldn’t save.'},
    );

    /* When */
    const state = run(failed, {
        type: 'agentHostSettingsLoaded',
        projectPath: BOX,
        settings: {...SETTINGS, copyConfig: false},
    });

    /* Then */
    assert.deepEqual(host(state).settings, {
        phase: 'ok',
        settings: {...SETTINGS, copyConfig: false},
        saveError: null,
    });
});
