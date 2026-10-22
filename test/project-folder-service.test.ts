/**
 * Checking a folder before it is added as a project (#171): what is there,
 * whether it is a repository on GitHub, and how far Tab completes the path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectFolderService } from '../src/application/services/project-folder-service';
import { completePath, expandHome } from '../src/domain/project/folder-check';
import { NodeFileSystem } from '../src/infrastructure/fs/node-file-system';

/** A home folder in the temp dir; `repositories` maps a folder to its origin remote (null: none). */
function setUp(folders: string[], repositories: Record<string, string | null> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-folder-check-'));
  for (const folder of folders) fs.mkdirSync(path.join(home, folder), { recursive: true });
  const node = new NodeFileSystem();
  const rootOf = (cwd: string): string | null => {
    for (const repo of Object.keys(repositories)) {
      const root = path.join(home, repo);
      if (cwd === root || cwd.startsWith(root + '/')) return root;
    }
    return null;
  };
  const service = new ProjectFolderService({
    fs: {
      exists: (p) => node.exists(p),
      isDirectory: (p) => node.isDirectory(p),
      readDir: (p) => node.readDir(p),
      homeDir: home,
    },
    git: {
      worktreeRoot: async (cwd) => rootOf(cwd),
      currentBranch: async () => 'main',
    },
    remotes: {
      originUrl: async (root) => {
        const repo = Object.keys(repositories).find(name => path.join(home, name) === root);
        return repo ? repositories[repo] : null;
      },
    },
  });
  return { home, service };
}

test('a repository on GitHub is found, read from under ~', async () => {
  /* Given */
  const { home, service } = setUp(['Development/rowlog'], { 'Development/rowlog': 'git@github.com:JBlaak/rowlog.git' });

  /* When */
  const check = await service.check('~/Development/rowlog/');

  /* Then */
  assert.deepEqual(check, {
    path: path.join(home, 'Development/rowlog'),
    exists: true, directory: true, git: true, branch: 'main', gitHubRepository: 'JBlaak/rowlog', completion: null,
  });
});

test('a repository whose origin is not on GitHub has no GitHub name', async () => {
  /* Given */
  const { service } = setUp(['box'], { box: 'git@gitlab.com:someone/box.git' });

  /* When */
  const check = await service.check('~/box');

  /* Then */
  assert.equal(check.git, true);
  assert.equal(check.gitHubRepository, null);
});

test('a plain folder exists but is not git', async () => {
  /* Given */
  const { service } = setUp(['notes']);

  /* When */
  const check = await service.check('~/notes');

  /* Then */
  assert.equal(check.directory, true);
  assert.equal(check.git, false);
  assert.equal(check.branch, null);
});

test('a missing folder does not exist, and nothing more is asked', async () => {
  /* Given */
  const { service } = setUp([]);

  /* When */
  const check = await service.check('~/nowhere');

  /* Then */
  assert.equal(check.exists, false);
  assert.equal(check.git, false);
});

test('Tab completes a unique folder with a slash, the way it was typed', async () => {
  /* Given */
  const { service } = setUp(['Development/rowlog', 'Documents']);

  /* When */
  const check = await service.check('~/Dev');

  /* Then */
  assert.equal(check.completion, '~/Development/');
});

test('Tab completes as far as several folders agree', async () => {
  /* Given */
  const { service } = setUp(['Development', 'Devices', 'Documents']);

  /* When */
  const check = await service.check('~/Dev');
  const stuck = await service.check('~/D');

  /* Then */
  assert.equal(check.completion, null);
  assert.equal(stuck.completion, null);
});

test('Tab completes a shared start of several folders', async () => {
  /* Given */
  const { service } = setUp(['Development', 'Devices']);

  /* When */
  const check = await service.check('~/D');

  /* Then */
  assert.equal(check.completion, '~/Dev');
});

// ── The rules ──

test('~ and ~/… expand to the home folder; other paths are kept', () => {
  /* When */
  const expanded = [expandHome('~', '/Users/me'), expandHome('~/x', '/Users/me/'), expandHome('/abs', '/Users/me')];

  /* Then */
  assert.deepEqual(expanded, ['/Users/me', '/Users/me/x', '/abs']);
});

test('several matches complete to what they share', () => {
  /* When */
  const completed = completePath('/code/sw', ['switchboard', 'swift-tools', 'other']);

  /* Then */
  assert.equal(completed, '/code/swi');
});

test('~ alone completes to ~/ when the home folder has a single folder', () => {
  /* When */
  const completed = completePath('~', ['Development']);

  /* Then */
  assert.equal(completed, '~/Development/');
});

test('hidden folders are left out until a dot is typed', () => {
  /* When */
  const plain = completePath('/code/', ['.git', 'app']);
  const dotted = completePath('/code/.', ['.git', 'app']);

  /* Then */
  assert.equal(plain, '/code/app/');
  assert.equal(dotted, '/code/.git/');
});

test('nothing to add, or nothing matching, completes nothing', () => {
  /* When */
  const none = completePath('/code/zz', ['app']);
  const noSlash = completePath('code', ['code']);

  /* Then */
  assert.equal(none, null);
  assert.equal(noSlash, null);
});
