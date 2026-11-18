import {test} from 'node:test';
import assert from 'node:assert/strict';

import {SessionRegistry} from '../src/application/model/session-registry';
import {SessionLauncher} from '../src/application/services/session-launcher';
import {fakeRenderer, fakeTerminals, fakeTimers, silentLog} from './support/fakes';
import type {SessionLauncherDeps} from '../src/application/services/session-launcher';

/**
 * Opening an archived session takes it out of the archive. Every way a
 * session is started or reopened comes through the launcher, so this is
 * where it is decided.
 */

function harness({archived, projectExists = true}: {archived: string[]; projectExists?: boolean}) {
    const renderer = fakeRenderer();
    const flags = new Map(archived.map((id) => [id, true]));
    const launcher = new SessionLauncher({
        registry: new SessionRegistry(),
        terminals: fakeTerminals(),
        shells: {list: () => [], resolve: () => ({id: 'zsh', name: 'zsh', path: '/bin/zsh'})},
        transcripts: {listSessionIds: () => [], readSlug: () => null},
        settings: {shellProfileId: () => null},
        lifecycle: {wire() {}, replayTo() {}},
        remote: {},
        renderer,
        questions: {settingsFor: () => null},
        git: {worktreeRoot: async () => null},
        clock: {now: () => 0},
        timers: fakeTimers(),
        log: silentLog,
        fileExists: () => projectExists,
        archive: {
            getMeta: (id: string) => (flags.get(id) ? {archived: 1} : null),
            setArchived: (id: string, value: boolean) => void flags.set(id, value),
        },
    } as unknown as SessionLauncherDeps);

    const open = (sessionId: string, isNew = false) => launcher.open({sessionId, projectPath: '/repo', isNew});
    return {
        open,
        archive: (id: string) => void flags.set(id, true),
        isArchived: (id: string) => flags.get(id) === true,
        renderer,
    };
}

test('resuming an archived session unarchives it and tells the lists', async () => {
    /* Given */
    const h = harness({archived: ['old']});

    /* When */
    const result = await h.open('old');

    /* Then */
    assert.equal(result.ok, true);
    assert.equal(h.isArchived('old'), false);
    assert.equal(h.renderer.only('projectsChanged').length, 1);
});

test('reattaching to a running archived session unarchives it', async () => {
    /* Given */
    const h = harness({archived: []});
    await h.open('live');
    h.archive('live');

    /* When */
    const result = await h.open('live');

    /* Then */
    assert.equal(result.reattached, true);
    assert.equal(h.isArchived('live'), false);
});

test('a session that is not archived is left alone', async () => {
    /* Given */
    const h = harness({archived: []});

    /* When */
    await h.open('fresh', true);

    /* Then */
    assert.equal(h.renderer.only('projectsChanged').length, 0);
});

test('an archived session that fails to open stays archived', async () => {
    /* Given */
    const h = harness({archived: ['old'], projectExists: false});

    /* When */
    const result = await h.open('old');

    /* Then */
    assert.equal(result.ok, false);
    assert.equal(h.isArchived('old'), true);
    assert.equal(h.renderer.only('projectsChanged').length, 0);
});
