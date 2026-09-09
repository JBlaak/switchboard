import test from 'node:test';
import assert from 'node:assert/strict';

import { AttributionService } from '../src/application/services/attribution-service';
import { FileTranscriptStore } from '../src/infrastructure/fs/transcript-store';
import { fakeFileSystem, silentLog } from './support/fakes';
import type { FakeFileSystem } from './support/fakes';

/**
 * The service side of attribution: find a project's transcripts, read the edit
 * claims out of them, and intersect with the paths git says actually changed.
 *
 * The two things worth pinning down are the ones that decide whether this can
 * run on every refresh. A transcript can be tens of megabytes and a project can
 * have hundreds, so an unchanged one must cost a `stat` and nothing more, and a
 * changed one must be read from where the last read stopped rather than whole.
 */

const PROJECTS_DIR = '/home/test/.claude/projects';
const PROJECT = '/home/test/proj';
const FOLDER = '-home-test-proj';
const SESSION_ONE = '6b0a184a-7d7e-4a59-8f36-7e173be5ea01';
const SESSION_TWO = 'fa46f37f-1aae-446e-8f3f-83f796468c35';
const TRANSCRIPT = `${PROJECTS_DIR}/${FOLDER}/${SESSION_ONE}.jsonl`;

/** Real entries, with the bulky `content` and `old_string` fields shortened. */
const ONE_WRITES_A = '{"parentUuid":null,"isSidechain":false,"userType":"external","cwd":"' + PROJECT + '","sessionId":"' + SESSION_ONE + '","version":"2.1.0","gitBranch":"main","message":{"id":"msg_01A","type":"message","role":"assistant","model":"claude-opus-4-5","content":[{"type":"tool_use","id":"toolu_01A","name":"Write","input":{"file_path":"' + PROJECT + '/src/a.ts","content":"export const a = 1;\\n"}}],"stop_reason":null},"requestId":"req_01A","type":"assistant","uuid":"00000000-0000-4000-8000-00000000000a","timestamp":"2026-08-12T12:00:00.000Z"}';

const ONE_WRITES_B = '{"parentUuid":"00000000-0000-4000-8000-00000000000a","isSidechain":false,"cwd":"' + PROJECT + '","sessionId":"' + SESSION_ONE + '","gitBranch":"main","message":{"id":"msg_01B","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01B","name":"Write","input":{"file_path":"src/b.ts","content":"export const b = 2;\\n"}}]},"type":"assistant","uuid":"00000000-0000-4000-8000-00000000000b","timestamp":"2026-08-12T12:05:00.000Z"}';

const ONE_EDITS_A_AGAIN = '{"parentUuid":"00000000-0000-4000-8000-00000000000b","isSidechain":false,"cwd":"' + PROJECT + '","sessionId":"' + SESSION_ONE + '","gitBranch":"main","message":{"id":"msg_01C","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01C","name":"Edit","input":{"file_path":"' + PROJECT + '/src/a.ts","old_string":"a = 1","new_string":"a = 3","replace_all":false}}]},"type":"assistant","uuid":"00000000-0000-4000-8000-00000000000c","timestamp":"2026-08-14T08:00:00.000Z"}';

const TWO_EDITS_A = '{"parentUuid":null,"isSidechain":false,"cwd":"' + PROJECT + '","sessionId":"' + SESSION_TWO + '","gitBranch":"feat/x","message":{"id":"msg_01D","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01D","name":"Edit","input":{"file_path":"' + PROJECT + '/src/a.ts","old_string":"a = 1","new_string":"a = 2","replace_all":false}}]},"type":"assistant","uuid":"00000000-0000-4000-8000-00000000000d","timestamp":"2026-08-13T09:00:00.000Z"}';

/** A subagent run: `isSidechain`, and the parent session's id. */
const SUBAGENT_WRITES_C = '{"parentUuid":null,"isSidechain":true,"cwd":"' + PROJECT + '","sessionId":"' + SESSION_ONE + '","gitBranch":"main","message":{"id":"msg_01E","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01E","name":"Write","input":{"file_path":"' + PROJECT + '/src/c.ts","content":"export const c = 3;\\n"}}]},"type":"assistant","uuid":"00000000-0000-4000-8000-00000000000e","timestamp":"2026-08-12T12:30:00.000Z"}';

/** Another project entirely, to prove the folder scan is scoped. */
const ELSEWHERE = '{"parentUuid":null,"isSidechain":false,"cwd":"/home/test/other","sessionId":"11111111-1111-4111-8111-111111111111","gitBranch":"main","message":{"id":"msg_01F","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01F","name":"Write","input":{"file_path":"/home/test/other/src/a.ts","content":"//\\n"}}]},"type":"assistant","uuid":"00000000-0000-4000-8000-00000000000f","timestamp":"2026-08-12T12:00:00.000Z"}';

/** One `readSlice`, as the service asked for it. */
interface ReadRange {
  path: string;
  start: number;
  length: number;
}

/**
 * The fake filesystem with every read recorded.
 *
 * The fake does not count reads on its own, and counting them is the whole
 * point here: "did not read it again" is the assertion, not "answered the
 * same".
 */
function recording(base: FakeFileSystem): { fs: FakeFileSystem; slices: ReadRange[]; whole: string[] } {
  const slices: ReadRange[] = [];
  const whole: string[] = [];
  const fs: FakeFileSystem = {
    ...base,
    readSlice(path, range) {
      slices.push({ path, start: range.start, length: range.length });
      return base.readSlice(path, range);
    },
    readText(path) {
      whole.push(path);
      return base.readText(path);
    },
  };
  return { fs, slices, whole };
}

function build(files: Record<string, string>) {
  const base = fakeFileSystem({ files, dirs: [PROJECTS_DIR] });
  const { fs, slices, whole } = recording(base);
  const transcripts = new FileTranscriptStore(fs, PROJECTS_DIR);
  const service = new AttributionService({ fs, transcripts, log: silentLog, projectsDir: PROJECTS_DIR });
  return { service, fs, slices, whole };
}

/** The seeded project: one session's transcript, a subagent's, and a stranger's. */
function seed(): Record<string, string> {
  return {
    [TRANSCRIPT]: [ONE_WRITES_A, ONE_WRITES_B].join('\n') + '\n',
    [`${PROJECTS_DIR}/${FOLDER}/${SESSION_TWO}.jsonl`]: TWO_EDITS_A + '\n',
    [`${PROJECTS_DIR}/${FOLDER}/${SESSION_ONE}/subagents/agent-a1209532.jsonl`]: SUBAGENT_WRITES_C + '\n',
    [`${PROJECTS_DIR}/-home-test-other/22222222-2222-4222-8222-222222222222.jsonl`]: ELSEWHERE + '\n',
  };
}

test('claims come from the transcripts, and a path git does not report is absent', async () => {
  const { service } = build(seed());

  const claims = await service.claimsFor(PROJECT, ['src/a.ts', 'src/b.ts', 'src/never-touched.ts']);

  // Keyed by the path as asked for — git prints them relative to the worktree —
  // while the claim itself carries the absolute path the transcripts agreed on.
  assert.deepEqual([...claims.keys()].sort(), ['src/a.ts', 'src/b.ts']);
  assert.equal(claims.get('src/a.ts')?.path, `${PROJECT}/src/a.ts`);

  // Two sessions on one file, most recent first.
  assert.deepEqual(claims.get('src/a.ts')?.sessions, [
    { sessionId: SESSION_TWO, lastAtIso: '2026-08-13T09:00:00.000Z', edits: 1 },
    { sessionId: SESSION_ONE, lastAtIso: '2026-08-12T12:00:00.000Z', edits: 1 },
  ]);
  // b.ts was written with a relative `file_path`, resolved against the entry's cwd.
  assert.deepEqual(claims.get('src/b.ts')?.sessions.map(s => s.sessionId), [SESSION_ONE]);

  // Nothing claims this one: it belongs in the "not by a session" group.
  assert.equal(claims.has('src/never-touched.ts'), false);
});

test('a subagent transcript attributes to the session that spawned it', async () => {
  const { service } = build(seed());

  // The file lives under `<folder>/<sessionId>/subagents/`, which is not among
  // the session ids the transcript store lists — but the entries carry the
  // parent session's id, so its edits are that session's.
  const claims = await service.claimsFor(PROJECT, [`${PROJECT}/src/c.ts`]);
  assert.deepEqual(claims.get(`${PROJECT}/src/c.ts`)?.sessions.map(s => s.sessionId), [SESSION_ONE]);
});

test('an unchanged transcript is not read a second time', async () => {
  const { service, slices, whole } = build(seed());

  const first = await service.claimsFor(PROJECT, ['src/a.ts']);
  const readsAfterFirst = slices.length;
  assert.ok(readsAfterFirst > 0, 'the first call has to read something');

  const second = await service.claimsFor(PROJECT, ['src/a.ts']);

  assert.equal(slices.length, readsAfterFirst, 'nothing moved, so nothing is read again');
  assert.deepEqual(second, first);
  // And no transcript is ever loaded whole: every read is a bounded slice.
  assert.deepEqual(whole, []);
});

test('an appended transcript is read from where the last read stopped', async () => {
  const { service, fs, slices } = build(seed());

  await service.claimsFor(PROJECT, ['src/a.ts']);
  const before = slices.length;
  const size = fs.stat(TRANSCRIPT)?.size ?? 0;

  // The CLI appends the next turn, as it does constantly.
  fs.writeText(TRANSCRIPT, fs.readText(TRANSCRIPT) + ONE_EDITS_A_AGAIN + '\n');

  const claims = await service.claimsFor(PROJECT, ['src/a.ts']);

  const added = slices.slice(before);
  assert.deepEqual(added.map(r => r.path), [TRANSCRIPT], 'only the file that moved is read');
  assert.equal(added[0].start, size, 'and only the bytes that were added');

  // The new edit lands on the session, and moves it to the front.
  assert.deepEqual(claims.get('src/a.ts')?.sessions, [
    { sessionId: SESSION_ONE, lastAtIso: '2026-08-14T08:00:00.000Z', edits: 2 },
    { sessionId: SESSION_TWO, lastAtIso: '2026-08-13T09:00:00.000Z', edits: 1 },
  ]);
});

test('a project with nothing asked about, or nothing claimed, answers empty', async () => {
  const { service, slices } = build(seed());

  assert.equal((await service.claimsFor(PROJECT, [])).size, 0);
  assert.equal(slices.length, 0, 'and does not go near the disk to say so');

  assert.equal((await service.claimsFor('/home/test/nowhere', ['src/a.ts'])).size, 0);
});
