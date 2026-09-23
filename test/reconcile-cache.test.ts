import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SessionIndex } from '../src/application/services/session-index';
import { NodeFileSystem } from '../src/infrastructure/fs/node-file-system';
import { FileTranscriptStore } from '../src/infrastructure/fs/transcript-store';
import { fakeRenderer, fakeTimers, silentLog } from './support/fakes';
import type { CachedSession, FolderMeta, SessionMeta } from '../src/domain/session/session';
import type { ProjectScanner } from '../src/application/ports/project-scanner';
import type { SearchIndex } from '../src/application/ports/search-index';
import type { SessionRepository } from '../src/application/ports/session-repository';

/**
 * The incremental re-index is what keeps sessions from silently going missing:
 * a folder that changed while the app was closed, or that predates the build
 * which first indexed it, is otherwise never picked up — the cold-start rebuild
 * only runs when the cache is completely empty.
 *
 * It also has to be cheap enough to run on every project list, which is why the
 * gate is a stat rather than a read. That is what these check.
 */

/** A minimal valid transcript: a `cwd` to resolve the project, and one turn. */
function writeSession(folderPath: string, cwd: string): void {
  fs.mkdirSync(folderPath, { recursive: true });
  const line = JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hello' } });
  fs.writeFileSync(path.join(folderPath, 'session.jsonl'), line + '\n', 'utf8');
}

/** An in-memory repository that records which folders actually got re-indexed. */
function fakeRepository(meta: Map<string, FolderMeta>) {
  const indexedFolders = new Set<string>();
  const cached = new Map<string, CachedSession>();

  const repository: SessionRepository = {
    getMeta: () => null,
    getAllMeta: () => new Map<string, SessionMeta>(),
    setName() {},
    toggleStar: () => 0,
    setArchived() {},

    isCachePopulated: () => cached.size > 0,
    getAllCached: () => [...cached.values()],
    getCachedSession: (id) => cached.get(id) ?? null,
    getCachedFolder: (id) => cached.get(id)?.folder ?? null,
    getCachedFingerprints: (folder) =>
      [...cached.values()].filter(s => s.folder === folder)
        .map(({ sessionId, fileMtime }) => ({ sessionId, fileMtime })),
    upsertCachedSessions(sessions) {
      for (const session of sessions) {
        indexedFolders.add(session.folder);
        cached.set(session.sessionId, session);
      }
    },
    deleteCachedSession(id) { cached.delete(id); },
    deleteCachedFolder(folder) {
      for (const [id, session] of cached) if (session.folder === folder) cached.delete(id);
      meta.delete(folder);
    },

    getAllFolderMeta: () => meta,
    setFolderMeta(folder, projectPath, indexMtimeMs) {
      meta.set(folder, { folder, projectPath, indexMtimeMs });
    },
  };

  return { repository, indexedFolders, cached };
}

const noSearchIndex: SearchIndex = {
  isPopulated: () => true,
  wasRecreated: () => false,
  upsert() {},
  deleteSession() {},
  deleteFolder() {},
  deleteType() {},
  updateTitle() {},
  query: () => [],
};

const noScanner: ProjectScanner = { scan: async () => [] };

function build(projectsDir: string, meta: Map<string, FolderMeta>) {
  const { repository, indexedFolders, cached } = fakeRepository(meta);
  const transcripts = new FileTranscriptStore(new NodeFileSystem(), projectsDir);
  const index = new SessionIndex({
    repository,
    searchIndex: noSearchIndex,
    transcripts,
    scanner: noScanner,
    renderer: fakeRenderer(),
    timers: fakeTimers(),
    log: silentLog,
  });
  return { index, indexedFolders, cached, transcripts };
}

test('reconcile indexes new and stale folders but skips up-to-date ones', () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-reconcile-'));
  try {
    // Never indexed (no meta), stale (meta older than disk), and up-to-date.
    writeSession(path.join(projectsDir, 'proj-new'), '/tmp/proj-new');
    writeSession(path.join(projectsDir, 'proj-stale'), '/tmp/proj-stale');
    writeSession(path.join(projectsDir, 'proj-current'), '/tmp/proj-current');

    const meta = new Map<string, FolderMeta>([
      ['proj-stale', { folder: 'proj-stale', projectPath: '/tmp/proj-stale', indexMtimeMs: 0 }],
    ]);
    const { index, indexedFolders, transcripts } = build(projectsDir, meta);
    meta.set('proj-current', {
      folder: 'proj-current',
      projectPath: '/tmp/proj-current',
      indexMtimeMs: transcripts.folderIndexMtimeMs('proj-current'),
    });

    index.reconcile();

    assert.ok(indexedFolders.has('proj-new'), 'a folder with no meta should be indexed');
    assert.ok(indexedFolders.has('proj-stale'), 'a folder newer than its gate should be re-indexed');
    assert.ok(!indexedFolders.has('proj-current'), 'an up-to-date folder should be skipped');
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});

test('a folder is re-read only for the transcripts whose mtime moved', () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-refresh-'));
  try {
    writeSession(path.join(projectsDir, 'proj'), '/tmp/proj');
    const { index, indexedFolders, cached } = build(projectsDir, new Map());

    index.refreshFolder('proj');
    assert.equal(cached.size, 1, 'the transcript is read the first time');

    // Nothing changed on disk, so the fingerprint match short-circuits the read.
    indexedFolders.clear();
    index.refreshFolder('proj');
    assert.ok(!indexedFolders.has('proj'), 'an unchanged transcript is not re-read');
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});

test('one deleted transcript among several is dropped from the cache', () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-drop-'));
  try {
    const folderPath = path.join(projectsDir, 'proj');
    writeSession(folderPath, '/tmp/proj');
    const second = JSON.stringify({
      type: 'user', cwd: '/tmp/proj', message: { role: 'user', content: 'second' },
    });
    fs.writeFileSync(path.join(folderPath, 'other.jsonl'), second + '\n', 'utf8');

    const { index, cached } = build(projectsDir, new Map());
    index.refreshFolder('proj');
    assert.equal(cached.size, 2);

    fs.rmSync(path.join(folderPath, 'other.jsonl'));
    index.refreshFolder('proj');

    assert.deepEqual([...cached.keys()], ['session'], 'the deleted transcript leaves no row behind');
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});

test('a folder that disappears is forgotten entirely', () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-gone-'));
  try {
    const folderPath = path.join(projectsDir, 'proj');
    writeSession(folderPath, '/tmp/proj');
    const { index, cached } = build(projectsDir, new Map());

    index.refreshFolder('proj');
    assert.equal(cached.size, 1);

    fs.rmSync(folderPath, { recursive: true });
    index.refreshFolder('proj');
    assert.equal(cached.size, 0);
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});
