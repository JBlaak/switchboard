import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeFileSystem } from '../src/infrastructure/fs/node-file-system';
import { FileTranscriptStore } from '../src/infrastructure/fs/transcript-store';

const FOLDER = '-Users-me-dev-web';
const SESSION = '5f0c2a6e-1111-4c4c-9a9a-0123456789ab';
const ROOT = '/Users/me/dev/web';
const AGENT_WT = ROOT + '/.claude/worktrees/agent-a1';

let projectsDir: string;
let store: FileTranscriptStore;

const user = (cwd: string, gitBranch: string, text: string) => JSON.stringify({
  type: 'user', cwd, gitBranch, sessionId: SESSION, timestamp: '2026-10-16T09:00:00Z',
  message: { role: 'user', content: text },
});
const assistant = (cwd: string, gitBranch: string, text: string) => JSON.stringify({
  type: 'assistant', cwd, gitBranch, sessionId: SESSION, timestamp: '2026-10-16T09:00:05Z',
  message: { role: 'assistant', content: [{ type: 'text', text }, { type: 'tool_use', name: 'Bash', input: {} }] },
});
const toolResult = (cwd: string, gitBranch: string, text: string) => JSON.stringify({
  type: 'user', cwd, gitBranch, sessionId: SESSION,
  message: { role: 'user', content: [{ type: 'tool_result', content: text }] },
});

function writeLines(file: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

before(() => {
  projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-transcripts-'));
  const folder = path.join(projectsDir, FOLDER);
  writeLines(path.join(folder, SESSION + '.jsonl'), [
    JSON.stringify({ type: 'file-history-snapshot', messageId: 'x', snapshot: {} }),
    user(ROOT, 'main', 'Work through #12 and acme/api#3, then look at https://github.com/acme/web/issues/40.'),
    assistant(ROOT + '/src', 'main', 'Starting a swarm for #12.'),
    toolResult(ROOT, 'main', 'gh issue list: #500 #501'),
    user(ROOT, 'HEAD', 'detached for a moment'),
    'not json at all',
  ]);
  writeLines(path.join(folder, SESSION, 'subagents', 'agent-b.jsonl'), [
    user(ROOT, 'main', 'Also back in the main checkout'),
  ]);
  writeLines(path.join(folder, SESSION, 'subagents', 'agent-a.jsonl'), [
    user(AGENT_WT, 'feat/12-billing', 'Implement #12; see also #13.'),
    assistant(AGENT_WT + '/src/billing', 'feat/12-billing', 'Done; this closes #12.'),
  ]);
  // Another session's subagents are not this session's.
  writeLines(path.join(folder, 'other-session', 'subagents', 'agent-z.jsonl'), [
    user('/elsewhere', 'feat/other', 'Fix #99'),
  ]);
  store = new FileTranscriptStore(new NodeFileSystem(), projectsDir);
});

after(() => {
  fs.rmSync(projectsDir, { recursive: true, force: true });
});

test('locations: every cwd + gitBranch in the main transcript and its subagents, once each, in first-seen order', () => {
  assert.deepEqual(store.locations(FOLDER, SESSION), [
    { cwd: ROOT, branch: 'main', fromSubagent: false },
    { cwd: ROOT + '/src', branch: 'main', fromSubagent: false },
    { cwd: AGENT_WT, branch: 'feat/12-billing', fromSubagent: true },
    { cwd: AGENT_WT + '/src/billing', branch: 'feat/12-billing', fromSubagent: true },
  ]);
});

test('issueMentions: what was said in the main transcript and its subagents, once each, not tool output', () => {
  assert.deepEqual(store.issueMentions(FOLDER, SESSION, 'acme/web'), [
    { repository: 'acme/web', number: 12 },
    { repository: 'acme/api', number: 3 },
    { repository: 'acme/web', number: 40 },
    { repository: 'acme/web', number: 13 },
  ]);
});

test('a session with no transcript has no locations and no mentions', () => {
  assert.deepEqual(store.locations(FOLDER, 'missing'), []);
  assert.deepEqual(store.issueMentions(FOLDER, 'missing', 'acme/web'), []);
  assert.deepEqual(store.locations('no-such-folder', SESSION), []);
});

test('a subagent-only session still has its subagents\' locations', () => {
  assert.deepEqual(store.locations(FOLDER, 'other-session'), [
    { cwd: '/elsewhere', branch: 'feat/other', fromSubagent: true },
  ]);
});
