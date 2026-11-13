/**
 * Archiving a landed PR's session when the PR merges (#440): idle ones at
 * once, busy ones at the end of their turn, never one with uncommitted changes.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ArchiveOnMergeService, type MergedSessionCandidate} from '../src/application/services/archive-on-merge-service';
import {isSamePullRequest, mergedSessionVerdict, sessionsOfMerged} from '../src/domain/merge-manager/archive-on-merge';
import type {FileChange} from '../src/domain/session-work/model';
import {silentLog} from './support/fakes';

const REPO = 'movelab/connect';
const PR_7 = {repository: REPO, number: 7, url: `https://github.com/${REPO}/pull/7`};

// ── The rule ──

test('an idle session is archived, a busy one waits for its turn, a dirty one is kept', () => {
    /* Then */
    assert.equal(mergedSessionVerdict({busy: false, dirty: false}), 'archive');
    assert.equal(mergedSessionVerdict({busy: true, dirty: false}), 'defer');
    assert.equal(mergedSessionVerdict({busy: false, dirty: true}), 'keep');
    assert.equal(mergedSessionVerdict({busy: true, dirty: true}), 'keep');
});

test("a merged PR's sessions are the unarchived ones that opened it, by repository or by URL", () => {
    /* Given */
    const sessions: MergedSessionCandidate[] = [
        {sessionId: 'a', pullRequests: [{...PR_7, repository: 'MoveLab/Connect'}]},
        {sessionId: 'b', pullRequests: [{...PR_7, repository: ''}]},
        {sessionId: 'c', archived: true, pullRequests: [PR_7]},
        {sessionId: 'd', pullRequests: [{...PR_7, repository: 'movelab/other'}]},
        {sessionId: 'e', pullRequests: [{...PR_7, number: 8}]},
    ];

    /* When */
    const found = sessionsOfMerged(sessions, [PR_7]);

    /* Then */
    assert.deepEqual(
        found.map((session) => session.sessionId),
        ['a', 'b'],
    );
    assert.equal(isSamePullRequest({...PR_7, repository: '', url: `${PR_7.url}/`}, PR_7), true);
});

// ── The service ──

function setup(world: {busy?: string[]; dirty?: string[]; sessions?: MergedSessionCandidate[]} = {}) {
    const busy = new Set(world.busy ?? []);
    const dirty = new Set(world.dirty ?? []);
    const archived: string[] = [];
    const sessions = world.sessions ?? [{sessionId: 's1', pullRequests: [PR_7]}];
    const service = new ArchiveOnMergeService({
        sessions: () => sessions,
        prompter: {runningId: (id) => id, isBusy: (id) => busy.has(id)},
        locate: (id) => ({folder: null, projectPath: `/work/${id}`}),
        transcripts: {locations: async () => []},
        git: {
            worktreeRoot: async (cwd) => cwd,
            status: async (root): Promise<FileChange[]> =>
                dirty.has(root.replace('/work/', '')) ? [{path: 'a.ts', status: 'modified'} as FileChange] : [],
        },
        archiver: {
            archive: (id) => {
                archived.push(id);
                return {ok: true};
            },
        },
        log: silentLog,
        agentlessRemote: () => false,
    });
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    return {service, archived, busy, dirty, settle};
}

test('an idle session is archived as soon as its PR merges', async () => {
    /* Given */
    const {service, archived} = setup();

    /* When */
    await service.merged([PR_7]);

    /* Then */
    assert.deepEqual(archived, ['s1']);
});

test('a busy session is archived at the end of its turn', async () => {
    /* Given */
    const {service, archived, busy, settle} = setup({busy: ['s1']});
    await service.merged([PR_7]);
    const during = [...archived];

    /* When */
    busy.delete('s1');
    service.turnEnded(['s1'], false, 's1');
    await settle();

    /* Then */
    assert.deepEqual(during, []);
    assert.deepEqual(archived, ['s1']);
    assert.equal(service.isDeferred('s1'), false);
});

test('a session that went by another id is archived under the one it goes by at the end of its turn', async () => {
    /* Given */
    const {service, archived, settle} = setup({busy: ['s1']});
    await service.merged([PR_7]);

    /* When */
    service.turnEnded(['s1', 's1-forked'], false, 's1-forked');
    await settle();

    /* Then */
    assert.deepEqual(archived, ['s1-forked']);
});

test('a session with uncommitted changes is kept, and so is one whose turn left some', async () => {
    /* Given */
    const dirtyNow = setup({dirty: ['s1']});
    const dirtyLater = setup({busy: ['s1']});

    /* When */
    await dirtyNow.service.merged([PR_7]);
    await dirtyLater.service.merged([PR_7]);
    dirtyLater.dirty.add('s1');
    dirtyLater.service.turnEnded(['s1'], false, 's1');
    await dirtyLater.settle();

    /* Then */
    assert.deepEqual(dirtyNow.archived, []);
    assert.deepEqual(dirtyLater.archived, []);
});

test('a busy session that asked to be archived itself is not archived twice', async () => {
    /* Given */
    const {service, archived, settle} = setup({busy: ['s1']});
    await service.merged([PR_7]);

    /* When */
    service.turnEnded(['s1'], true, 's1');
    await settle();

    /* Then */
    assert.deepEqual(archived, []);
    assert.equal(service.isDeferred('s1'), false);
});

test("other sessions' turns ending archive nothing", async () => {
    /* Given */
    const {service, archived, settle} = setup({busy: ['s1']});
    await service.merged([PR_7]);

    /* When */
    service.turnEnded(['s2'], false, 's2');
    await settle();

    /* Then */
    assert.deepEqual(archived, []);
    assert.equal(service.isDeferred('s1'), true);
});
