/**
 * VM worktree projects that outlive their worktree: dropped when the archive
 * cleanup removes the worktree, and swept on connect when it is already gone.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {remoteProjectsIn, worktreeProjectCandidates} from '../src/domain/project/vm-worktree-projects';
import {VmWorktreeProjectSweep} from '../src/application/services/vm-worktree-project-sweep';
import type {RemoteProjectSetting} from '../src/domain/settings/settings';
import {remoteProjectPath} from '../src/domain/project/remote-target';

const HOST = {user: 'dev', host: 'vm.local', port: 22};
const HOME = '/home/dev';
const REPO_DIR = '~/projects/site';
const WORKTREE_DIR = REPO_DIR + '/.claude/worktrees/12-billing';
/** The worktree as git names it: absolute. */
const GIT_WORKTREE = 'ssh://dev@vm.local//home/dev/projects/site/.claude/worktrees/12-billing';
const GIT_REPO = 'ssh://dev@vm.local//home/dev/projects/site';

function project(dir: string, sessions: string[] = [], host = HOST): RemoteProjectSetting {
    return {
        ...host,
        dir,
        sessions: sessions.map((sessionId) => ({sessionId, kind: 'claude' as const, created: '2026-11-01T00:00:00Z'})),
    };
}

const path = (dir: string, host = HOST) => remoteProjectPath({...host, dir});

// ── Which records a removed worktree leaves ──

test('a removed worktree named absolutely drops the project stored under its ~ name', () => {
    /* Given */
    const remotes = [project(REPO_DIR), project(WORKTREE_DIR), project(WORKTREE_DIR + '/packages/web')];

    /* When */
    const gone = remoteProjectsIn(remotes, GIT_WORKTREE, HOME);

    /* Then */
    assert.deepEqual(gone, [path(WORKTREE_DIR), path(WORKTREE_DIR + '/packages/web')]);
});

test('the repository, a sibling with a longer name and another host keep their projects', () => {
    /* Given */
    const remotes = [
        project(REPO_DIR),
        project(WORKTREE_DIR + '-other'),
        project(WORKTREE_DIR, [], {...HOST, host: 'other.local'}),
    ];

    /* When */
    const gone = remoteProjectsIn(remotes, GIT_WORKTREE, HOME);

    /* Then */
    assert.deepEqual(gone, []);
});

test('without the VM home only a project named the same way as git is dropped', () => {
    /* Given */
    const remotes = [project(WORKTREE_DIR), project('/home/dev/projects/site/.claude/worktrees/12-billing')];

    /* When */
    const gone = remoteProjectsIn(remotes, GIT_WORKTREE, null);

    /* Then */
    assert.deepEqual(gone, ['ssh://dev@vm.local//home/dev/projects/site/.claude/worktrees/12-billing']);
});

// ── Which records the sweep looks at ──

test('the sweep looks only at worktree projects with no session still listed', () => {
    /* Given */
    const remotes = [
        project(REPO_DIR),
        project(WORKTREE_DIR, ['archived']),
        project(REPO_DIR + '/.claude/worktrees/13-busy', ['archived', 'live']),
        project(REPO_DIR + '/.claude/worktrees/14-empty'),
        project(WORKTREE_DIR, [], {...HOST, host: 'other.local'}),
    ];

    /* When */
    const candidates = worktreeProjectCandidates(remotes, HOST, (id) => id === 'archived');

    /* Then */
    assert.deepEqual(candidates, [
        {path: path(WORKTREE_DIR), repository: path(REPO_DIR)},
        {path: path(REPO_DIR + '/.claude/worktrees/14-empty'), repository: path(REPO_DIR)},
    ]);
});

// ── The sweep ──

function sweep(remotes: RemoteProjectSetting[], roots: Record<string, string | null>) {
    let stored = remotes;
    const changed: string[] = [];
    const service = new VmWorktreeProjectSweep({
        settings: {
            remoteProjects: () => stored,
            removeRemoteProject: (gone) => {
                stored = stored.filter((remote) => remoteProjectPath(remote) !== gone);
            },
        },
        git: {worktreeRoot: async (cwd) => roots[cwd] ?? null},
        archived: () => true,
        renderer: {projectsChanged: () => changed.push('projects')},
        log: {debug() {}, info() {}, warn() {}, error() {}},
    });
    return {service, stored: () => stored.map(remoteProjectPath), changed};
}

test('a worktree project whose folder git no longer finds is dropped; one still there stays', async () => {
    /* Given */
    const kept = REPO_DIR + '/.claude/worktrees/13-kept';
    const leftover = REPO_DIR + '/.claude/worktrees/14-leftover';
    const h = sweep([project(REPO_DIR), project(WORKTREE_DIR), project(kept), project(leftover)], {
        [path(REPO_DIR)]: GIT_REPO,
        [path(kept)]: GIT_REPO + '/.claude/worktrees/13-kept',
        // A plain directory left behind resolves to the repository around it.
        [path(leftover)]: GIT_REPO,
    });

    /* When */
    await h.service.connected(HOST);

    /* Then */
    assert.deepEqual(h.stored(), [path(REPO_DIR), path(kept)]);
    assert.deepEqual(h.changed, ['projects']);
});

test('nothing is dropped when git does not answer for the repository', async () => {
    /* Given */
    const h = sweep([project(REPO_DIR), project(WORKTREE_DIR)], {});

    /* When */
    await h.service.connected(HOST);

    /* Then */
    assert.deepEqual(h.stored(), [path(REPO_DIR), path(WORKTREE_DIR)]);
    assert.deepEqual(h.changed, []);
});
