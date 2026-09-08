import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getFolderIndexMtimeMs } from '../src/shared/folder-index-state.js';

test('folder index timestamp advances when an existing session file is appended', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-folder-index-'));

  try {
    const sessionPath = path.join(tmpDir, 'session.jsonl');
    fs.writeFileSync(sessionPath, '{"type":"user","message":"first"}\n', 'utf8');

    const before = getFolderIndexMtimeMs(tmpDir);

    await new Promise(resolve => setTimeout(resolve, 1100));

    fs.appendFileSync(sessionPath, '{"type":"assistant","message":"second"}\n', 'utf8');

    const after = getFolderIndexMtimeMs(tmpDir);

    assert.ok(after > before, `expected index mtime to increase (${before} -> ${after})`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
