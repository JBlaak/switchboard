import {after, test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {NodeFileSystem} from '../src/infrastructure/fs/node-file-system';
import {FileTranscriptStore} from '../src/infrastructure/fs/transcript-store';
import {PAGE_TOOL_QUALIFIED_NAME} from '../src/domain/session/page-tool';

/** What a session made that only its transcripts record (#340), main and subagents together. */

const FOLDER = '-Users-me-dev-web';
const SESSION = '5f0c2a6e-2222-4c4c-9a9a-0123456789ab';
const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-products-'));

after(() => fs.rmSync(projectsDir, {recursive: true, force: true}));

const reply = (text: string) =>
    JSON.stringify({type: 'assistant', message: {role: 'assistant', content: [{type: 'text', text}]}});
const showPage = (id: string, title: string) =>
    JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-06T10:00:00Z',
        message: {
            role: 'assistant',
            content: [{type: 'tool_use', id, name: PAGE_TOOL_QUALIFIED_NAME, input: {title, html: '<p>x</p>'}}],
        },
    });

function write(file: string, lines: string[]): void {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, lines.join('\n') + '\n');
}

test("a session's artifacts and pages come from its transcript and its subagents', once each", () => {
    /* Given */
    const folder = path.join(projectsDir, FOLDER);
    write(path.join(folder, SESSION + '.jsonl'), [
        reply('See https://claude.ai/artifact/AAA'),
        showPage('p1', 'Summary'),
    ]);
    write(path.join(folder, SESSION, 'subagents', 'agent-a.jsonl'), [
        reply('Also https://claude.ai/artifact/AAA and https://claude.ai/artifact/BBB'),
    ]);
    const store = new FileTranscriptStore(new NodeFileSystem(), projectsDir);

    /* When */
    const products = store.products(FOLDER, SESSION);

    /* Then */
    assert.deepEqual(
        {artifacts: products.artifacts.map((a) => a.id), pages: products.pages.map((p) => p.title)},
        {artifacts: ['AAA', 'BBB'], pages: ['Summary']},
    );
});
