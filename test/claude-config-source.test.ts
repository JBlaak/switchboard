import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {NodeClaudeConfigSource} from '../src/infrastructure/fs/claude-config-source';

/** Reading the Mac's ~/.claude for the config copy: links followed, loops and excluded folders not walked. */

function tempClaude(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-src-'));
}

test('files below a folder are listed relative to ~/.claude, through a linked skill, without node_modules', () => {
    /* Given */
    const root = tempClaude();
    const checkout = tempClaude();
    fs.mkdirSync(path.join(root, 'skills/plain'), {recursive: true});
    fs.writeFileSync(path.join(root, 'skills/plain/SKILL.md'), '# plain');
    fs.writeFileSync(path.join(checkout, 'SKILL.md'), '# linked');
    fs.mkdirSync(path.join(checkout, 'node_modules/x'), {recursive: true});
    fs.writeFileSync(path.join(checkout, 'node_modules/x/index.js'), '');
    fs.symlinkSync(checkout, path.join(root, 'skills/linked'));

    /* When */
    const listed = new NodeClaudeConfigSource(root, '/Users/me').list('skills').map((entry) => entry.path);

    /* Then */
    assert.deepEqual(listed.sort(), ['skills/linked/SKILL.md', 'skills/plain/SKILL.md']);
});

test('a link back to a folder being walked is not followed again', () => {
    /* Given */
    const root = tempClaude();
    fs.mkdirSync(path.join(root, 'commands'), {recursive: true});
    fs.writeFileSync(path.join(root, 'commands/a.md'), 'a');
    fs.symlinkSync(path.join(root, 'commands'), path.join(root, 'commands/loop'));

    /* When */
    const listed = new NodeClaudeConfigSource(root, '/Users/me').list('commands').map((entry) => entry.path);

    /* Then */
    assert.deepEqual(listed, ['commands/a.md']);
});

test('a missing file stats as null and a missing folder lists nothing', () => {
    /* Given */
    const source = new NodeClaudeConfigSource(tempClaude(), '/Users/me');

    /* When */
    const stat = source.stat('CLAUDE.md');
    const listed = source.list('agents');

    /* Then */
    assert.equal(stat, null);
    assert.deepEqual(listed, []);
});
