import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {NodeFileSystem} from '../src/infrastructure/fs/node-file-system';
import {FileTranscriptStore} from '../src/infrastructure/fs/transcript-store';

const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-folder-index-'));
after(() => fs.rmSync(projectsDir, {recursive: true, force: true}));

/** Set a file's or directory's access and modification times to `at`. */
function backdate(target: string, at: Date): void {
    fs.utimesSync(target, at, at);
}

// The CLI appends to a transcript in place. That moves the file's mtime but not
// the folder's, so a gate on the folder's mtime alone would never see a
// session carry on.
test("appending to a transcript moves its folder's index stamp, though the folder's own mtime stays", () => {
    /* Given */
    const transcripts = new FileTranscriptStore(new NodeFileSystem(), projectsDir);
    const folderPath = path.join(projectsDir, '-code-app');
    const transcript = path.join(folderPath, 'session.jsonl');
    fs.mkdirSync(folderPath);
    fs.writeFileSync(transcript, JSON.stringify({type: 'user', message: 'one'}) + '\n');
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    backdate(transcript, anHourAgo);
    backdate(folderPath, anHourAgo);
    const stampBefore = transcripts.folderIndexMtimeMs('-code-app');

    /* When */
    fs.appendFileSync(transcript, JSON.stringify({type: 'assistant', message: 'two'}) + '\n');

    /* Then */
    const stampAfter = transcripts.folderIndexMtimeMs('-code-app');
    assert.ok(stampAfter > stampBefore, `the stamp went from ${stampBefore} to ${stampAfter}`);
    assert.equal(fs.statSync(folderPath).mtimeMs, anHourAgo.getTime(), "the folder's own mtime did not move");
});
