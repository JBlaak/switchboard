import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NodeFileSystem } from '../src/infrastructure/fs/node-file-system';
import { FileTranscriptStore } from '../src/infrastructure/fs/transcript-store';

test('folder index timestamp advances when an existing session file is appended', async () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-folder-index-'));
  const transcripts = new FileTranscriptStore(new NodeFileSystem(), projectsDir);

  try {
    // A transcript is appended in place, which moves the file's mtime but often
    // leaves the containing directory's alone — so the directory's own mtime
    // cannot be the index gate on its own.
    const folder = '-repo';
    fs.mkdirSync(path.join(projectsDir, folder));
    const sessionPath = path.join(projectsDir, folder, 'session.jsonl');
    fs.writeFileSync(sessionPath, '{"type":"user","message":"first"}\n', 'utf8');

    const before = transcripts.folderIndexMtimeMs(folder);

    // Filesystem mtime resolution is coarse enough that a same-second append
    // would not be distinguishable.
    await new Promise(resolve => setTimeout(resolve, 1100));

    fs.appendFileSync(sessionPath, '{"type":"assistant","message":"second"}\n', 'utf8');

    const after = transcripts.folderIndexMtimeMs(folder);
    assert.ok(after > before, `expected index mtime to increase (${before} -> ${after})`);
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});
