import test from 'node:test';
import assert from 'node:assert/strict';

import {
  claimsForPaths, claimsFromTranscriptLine, groupClaims, resolveClaimPath,
} from '../src/domain/attribution/claims';

/**
 * Attribution reads who changed a file out of the transcripts, because that is
 * the only source that is complete: the MCP bridge's `openDiff` is silent in
 * `acceptEdits`, silent with IDE emulation off, and knows nothing from before
 * the app launched. Every file-modifying tool call, by contrast, is written
 * into the session's own `.jsonl`.
 *
 * The lines below are real transcript entries with the bulky fields (system
 * prompts, file contents, `old_string`/`new_string`) shortened. Nothing else is
 * touched: the shape is what these have to keep working against, and it is not
 * ours to change.
 */

const SESSION_A = '6b0a184a-7d7e-4a59-8f36-7e173be5ea01';
const SESSION_B = 'fa46f37f-1aae-446e-8f3f-83f796468c35';
const TYPES = '/Users/j/dev/switchboard/src/domain/attribution/types.ts';
const CLAIMS = '/Users/j/dev/switchboard/src/domain/attribution/claims.ts';

const WRITE_LINE = '{"parentUuid":"d79f846e-7877-4e7a-b882-e7a8f593ccd5","isSidechain":false,"userType":"external","cwd":"/Users/j/dev/switchboard","sessionId":"' + SESSION_A + '","version":"2.1.0","gitBranch":"main","message":{"id":"msg_01ABC","type":"message","role":"assistant","model":"claude-opus-4-5","content":[{"type":"tool_use","id":"toolu_011zxLocP48zw9NoVgbgMLDj","name":"Write","input":{"file_path":"' + TYPES + '","content":"export interface EditClaim {}\\n"}}],"stop_reason":null,"usage":{"input_tokens":4,"output_tokens":91}},"requestId":"req_011CVpNq","type":"assistant","uuid":"9f13942e-a551-4af8-b0ee-d85eff2d1c1c","timestamp":"2026-08-12T12:27:39.632Z"}';

const EDIT_LINE = '{"parentUuid":"9f13942e-a551-4af8-b0ee-d85eff2d1c1c","isSidechain":false,"userType":"external","cwd":"/Users/j/dev/switchboard","sessionId":"' + SESSION_A + '","version":"2.1.0","gitBranch":"main","message":{"id":"msg_01DEF","type":"message","role":"assistant","model":"claude-opus-4-5","content":[{"type":"tool_use","id":"toolu_01Ka4bLmNo","name":"Edit","input":{"file_path":"' + CLAIMS + '","old_string":"const x = 1","new_string":"const x = 2","replace_all":false}}],"stop_reason":null},"requestId":"req_011CVpNr","type":"assistant","uuid":"a1b2c3d4-0000-4000-8000-000000000001","timestamp":"2026-08-12T12:31:02.114Z"}';

/** Two tool calls in one assistant turn — the CLI batches independent edits. */
const MULTI_BLOCK_LINE = '{"parentUuid":"a1b2c3d4-0000-4000-8000-000000000001","isSidechain":false,"cwd":"/Users/j/dev/switchboard","sessionId":"' + SESSION_A + '","gitBranch":"main","message":{"id":"msg_01GHI","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01Mm","name":"MultiEdit","input":{"file_path":"' + TYPES + '","edits":[{"old_string":"a","new_string":"b"}]}},{"type":"tool_use","id":"toolu_01Nn","name":"NotebookEdit","input":{"notebook_path":"/Users/j/dev/switchboard/notes.ipynb","new_source":"print(1)","cell_type":"code","edit_mode":"replace"}}]},"type":"assistant","uuid":"a1b2c3d4-0000-4000-8000-000000000002","timestamp":"2026-08-12T12:33:00.000Z"}';

/** A session whose `cwd` was a subdirectory, which is why relative paths matter. */
const RELATIVE_LINE = '{"parentUuid":null,"isSidechain":false,"cwd":"/Users/j/dev/switchboard/src/renderer","sessionId":"' + SESSION_B + '","gitBranch":"main","message":{"id":"msg_01JKL","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01Oo","name":"Write","input":{"file_path":"./features/rail/rail-model.ts","content":"//\\n"}}]},"type":"assistant","uuid":"a1b2c3d4-0000-4000-8000-000000000003","timestamp":"2026-08-12T13:00:00.000Z"}';

/** The user entry that follows a tool call: the *result*, not a second edit. */
const TOOL_RESULT_LINE = '{"parentUuid":"9f13942e-a551-4af8-b0ee-d85eff2d1c1c","isSidechain":false,"cwd":"/Users/j/dev/switchboard","sessionId":"' + SESSION_A + '","gitBranch":"main","type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_011zxLocP48zw9NoVgbgMLDj","type":"tool_result","content":"File created successfully at: ' + TYPES + '"}]},"uuid":"a1b2c3d4-0000-4000-8000-000000000004","timestamp":"2026-08-12T12:27:40.000Z","toolUseResult":{"type":"create","filePath":"' + TYPES + '"}}';

const READ_LINE = '{"parentUuid":null,"isSidechain":false,"cwd":"/Users/j/dev/switchboard","sessionId":"' + SESSION_A + '","gitBranch":"main","message":{"id":"msg_01MNO","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01Pp","name":"Read","input":{"file_path":"' + TYPES + '"}}]},"type":"assistant","uuid":"a1b2c3d4-0000-4000-8000-000000000005","timestamp":"2026-08-12T12:20:00.000Z"}';

const BASH_LINE = '{"parentUuid":null,"isSidechain":false,"cwd":"/Users/j/dev/switchboard","sessionId":"' + SESSION_A + '","gitBranch":"main","message":{"id":"msg_01PQR","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01Qq","name":"Bash","input":{"command":"echo hi > ' + TYPES + '","description":"Write the file the hard way"}}]},"type":"assistant","uuid":"a1b2c3d4-0000-4000-8000-000000000006","timestamp":"2026-08-12T12:21:00.000Z"}';

/** A subagent's edit. `isSidechain` is set, and `sessionId` is the *parent's*. */
const SIDECHAIN_LINE = '{"parentUuid":null,"isSidechain":true,"cwd":"/Users/j/dev/switchboard/.claude/worktrees/agent-a12095324dbcf4414","sessionId":"' + SESSION_B + '","gitBranch":"main","message":{"id":"msg_01STU","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01Rr","name":"Write","input":{"file_path":"/Users/j/dev/switchboard/.claude/worktrees/agent-a12095324dbcf4414/src/domain/browse/types.ts","content":"//\\n"}}]},"type":"assistant","uuid":"a1b2c3d4-0000-4000-8000-000000000007","timestamp":"2026-09-09T12:30:20.788Z"}';

/** A second session editing a file the first one already wrote. */
const OTHER_SESSION_LINE = '{"parentUuid":null,"isSidechain":false,"cwd":"/Users/j/dev/switchboard","sessionId":"' + SESSION_B + '","gitBranch":"feat/x","message":{"id":"msg_01VWX","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01Ss","name":"Edit","input":{"file_path":"' + TYPES + '","old_string":"b","new_string":"c","replace_all":false}}]},"type":"assistant","uuid":"a1b2c3d4-0000-4000-8000-000000000008","timestamp":"2026-08-13T09:00:00.000Z"}';

test('a Write entry claims its path for the session that asked', () => {
  assert.deepEqual(claimsFromTranscriptLine(WRITE_LINE), [{
    sessionId: SESSION_A,
    path: TYPES,
    atIso: '2026-08-12T12:27:39.632Z',
    tool: 'Write',
  }]);
});

test('Edit, MultiEdit and NotebookEdit all claim, and NotebookEdit uses notebook_path', () => {
  assert.deepEqual(claimsFromTranscriptLine(EDIT_LINE).map(c => [c.tool, c.path]), [['Edit', CLAIMS]]);

  // One turn, two tool calls: a claim each, in the order the model made them.
  assert.deepEqual(claimsFromTranscriptLine(MULTI_BLOCK_LINE).map(c => [c.tool, c.path]), [
    ['MultiEdit', TYPES],
    ['NotebookEdit', '/Users/j/dev/switchboard/notes.ipynb'],
  ]);
});

test('a relative file_path resolves against the entry own cwd, not the project', () => {
  assert.deepEqual(claimsFromTranscriptLine(RELATIVE_LINE), [{
    sessionId: SESSION_B,
    path: '/Users/j/dev/switchboard/src/renderer/features/rail/rail-model.ts',
    atIso: '2026-08-12T13:00:00.000Z',
    tool: 'Write',
  }]);

  // The rule on its own, including the `..` a relative path can carry.
  assert.equal(resolveClaimPath('/a/b', 'c/d.ts'), '/a/b/c/d.ts');
  assert.equal(resolveClaimPath('/a/b', '../c/d.ts'), '/a/c/d.ts');
  assert.equal(resolveClaimPath('/a/b', '/elsewhere/d.ts'), '/elsewhere/d.ts');
  assert.equal(resolveClaimPath('C:\\dev\\proj', 'src\\d.ts'), 'C:\\dev\\proj\\src\\d.ts');
});

test('a tool result, a Read and a Bash write are not claims', () => {
  // The user entry echoing the result would double-count every edit.
  assert.deepEqual(claimsFromTranscriptLine(TOOL_RESULT_LINE), []);
  assert.deepEqual(claimsFromTranscriptLine(READ_LINE), []);
  // Bash can of course write a file, but its input is a command, not a path.
  assert.deepEqual(claimsFromTranscriptLine(BASH_LINE), []);
});

test('a malformed or empty line yields nothing without throwing', () => {
  // The last line of a file being appended to is routinely half-written.
  const truncated = WRITE_LINE.slice(0, WRITE_LINE.length - 40);
  assert.deepEqual(claimsFromTranscriptLine(truncated), []);
  assert.deepEqual(claimsFromTranscriptLine(''), []);
  assert.deepEqual(claimsFromTranscriptLine('   '), []);
  assert.deepEqual(claimsFromTranscriptLine('not json at all'), []);
  assert.deepEqual(claimsFromTranscriptLine('null'), []);
  assert.deepEqual(claimsFromTranscriptLine('[1,2,3]'), []);
  assert.deepEqual(claimsFromTranscriptLine('{"type":"assistant"}'), []);
  assert.deepEqual(claimsFromTranscriptLine('{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Write","input":{}}]}}'), []);
});

test('a subagent edit attributes to the session that spawned it', () => {
  // `isSidechain` is set on these, but the `sessionId` they carry is the
  // parent's — so no special case, and the answer is the one the UI wants.
  assert.deepEqual(claimsFromTranscriptLine(SIDECHAIN_LINE).map(c => c.sessionId), [SESSION_B]);
});

test('grouping counts a session edits and orders sessions most recent first', () => {
  const claims = [
    ...claimsFromTranscriptLine(WRITE_LINE),
    ...claimsFromTranscriptLine(EDIT_LINE),
    ...claimsFromTranscriptLine(MULTI_BLOCK_LINE),
    ...claimsFromTranscriptLine(OTHER_SESSION_LINE),
  ];

  const byPath = groupClaims(claims);
  assert.deepEqual([...byPath.keys()].sort(), [
    CLAIMS, '/Users/j/dev/switchboard/notes.ipynb', TYPES,
  ].sort());

  // types.ts: session A wrote then edited it, session B edited it a day later.
  const types = byPath.get(TYPES);
  assert.deepEqual(types, {
    path: TYPES,
    sessions: [
      { sessionId: SESSION_B, lastAtIso: '2026-08-13T09:00:00.000Z', edits: 1 },
      { sessionId: SESSION_A, lastAtIso: '2026-08-12T12:33:00.000Z', edits: 2 },
    ],
  });

  // One file, two sessions is routine, and both have to survive: 10 of one
  // project's 60 most-edited paths were touched by more than one session.
  assert.equal(types?.sessions.length, 2);
  assert.deepEqual(byPath.get(CLAIMS)?.sessions.map(s => s.sessionId), [SESSION_A]);
});

test('claimsForPaths keeps what git reports and drops what it does not', () => {
  const byPath = groupClaims([
    ...claimsFromTranscriptLine(WRITE_LINE),
    ...claimsFromTranscriptLine(EDIT_LINE),
  ]);

  // git says only claims.ts is dirty: the Write on types.ts was rejected, or
  // reverted, and a claim is not evidence that anything landed.
  const wanted = claimsForPaths(byPath, [CLAIMS, '/Users/j/dev/switchboard/README.md']);
  assert.deepEqual([...wanted.keys()], [CLAIMS]);
  assert.deepEqual(wanted.get(CLAIMS)?.sessions.map(s => s.sessionId), [SESSION_A]);
  assert.equal(wanted.has(TYPES), false);
  assert.equal(wanted.has('/Users/j/dev/switchboard/README.md'), false);
});
