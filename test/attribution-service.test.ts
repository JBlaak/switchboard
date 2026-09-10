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
  // while the claim carries the identity the transcripts were folded under,
  // which for a path inside the project is its place inside it.
  assert.deepEqual([...claims.keys()].sort(), ['src/a.ts', 'src/b.ts']);
  assert.equal(claims.get('src/a.ts')?.path, 'src/a.ts');

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

// ── Across the worktrees of one repository ───────────────────────────────────
//
// The case this feature is for: several sessions at once, each in its own
// checkout. A claim is an absolute path inside the checkout its session ran in,
// so before the fold a question about a sibling's copy of the same file matched
// nothing — measured on the Switchboard repository, 105 changed files came back
// 6 attributed and 99 in `Generated · not by a session`.

/** Claude CLI's own worktree layout: `<project>/.claude/worktrees/<name>`. */
const AGENT_A = `${PROJECT}/.claude/worktrees/agent-a`;
const M1_RAIL = `${PROJECT}/.claude/worktrees/m1-project-rail`;
const AGENT_A_FOLDER = '-home-test-proj--claude-worktrees-agent-a';
const SESSION_THREE = '9c3e1d20-0b5a-4d18-9a77-2f6c4b8e0d11';
const SESSION_FOUR = '4d5e6f70-1a2b-4c3d-8e9f-0a1b2c3d4e5f';

/** A session running in worktree `agent-a`, editing that worktree's copy. */
const AGENT_A_WRITES_A = '{"parentUuid":null,"isSidechain":false,"cwd":"' + AGENT_A + '","sessionId":"' + SESSION_THREE + '","gitBranch":"agent-a","message":{"id":"msg_02A","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_02A","name":"Edit","input":{"file_path":"' + AGENT_A + '/src/a.ts","old_string":"a = 1","new_string":"a = 9","replace_all":false}}]},"type":"assistant","uuid":"00000000-0000-4000-8000-00000000001a","timestamp":"2026-08-15T10:00:00.000Z"}';

/** The same session, running one directory down and naming its file relatively. */
const AGENT_A_SUBDIR_WRITES_D = '{"parentUuid":null,"isSidechain":false,"cwd":"' + AGENT_A + '/src","sessionId":"' + SESSION_FOUR + '","gitBranch":"agent-a","message":{"id":"msg_02B","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_02B","name":"Write","input":{"file_path":"d.ts","content":"export const d = 4;\\n"}}]},"type":"assistant","uuid":"00000000-0000-4000-8000-00000000001b","timestamp":"2026-08-15T11:00:00.000Z"}';

/** A different repository that happens to live inside this one, with the same paths. */
const VENDOR = `${PROJECT}/vendor/other`;
const VENDOR_WRITES_A = '{"parentUuid":null,"isSidechain":false,"cwd":"' + VENDOR + '","sessionId":"33333333-3333-4333-8333-333333333333","gitBranch":"main","message":{"id":"msg_02C","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_02C","name":"Write","input":{"file_path":"' + VENDOR + '/src/a.ts","content":"//\\n"}}]},"type":"assistant","uuid":"00000000-0000-4000-8000-00000000001c","timestamp":"2026-08-15T12:00:00.000Z"}';

/** The seed, plus a worktree of the project and a stranger nested inside it. */
function seedWithWorktrees(): Record<string, string> {
  return {
    ...seed(),
    [`${PROJECTS_DIR}/${AGENT_A_FOLDER}/${SESSION_THREE}.jsonl`]: AGENT_A_WRITES_A + '\n',
    [`${PROJECTS_DIR}/${AGENT_A_FOLDER}-src/${SESSION_FOUR}.jsonl`]: AGENT_A_SUBDIR_WRITES_D + '\n',
    [`${PROJECTS_DIR}/-home-test-proj-vendor-other/33333333-3333-4333-8333-333333333333.jsonl`]:
      VENDOR_WRITES_A + '\n',
    // The worktrees have to exist for the CLI's layout to fold to the project.
    [`${AGENT_A}/.git`]: 'gitdir: /home/test/proj/.git/worktrees/agent-a\n',
    [`${M1_RAIL}/.git`]: 'gitdir: /home/test/proj/.git/worktrees/m1-project-rail\n',
  };
}

test('a claim from a sibling worktree attributes to the file being asked about', async () => {
  const { service } = build(seedWithWorktrees());

  // The user is looking at `m1-project-rail`, where nothing has ever run. The
  // edit was made in `agent-a`, against that checkout's own absolute path.
  const claims = await service.claimsFor(
    PROJECT, [`${M1_RAIL}/src/a.ts`], [PROJECT, AGENT_A, M1_RAIL]);

  assert.deepEqual(claims.get(`${M1_RAIL}/src/a.ts`)?.sessions.map(s => s.sessionId),
    [SESSION_THREE, SESSION_TWO, SESSION_ONE],
    'the sibling worktree, and the two that ran in the project itself');
});

test('a claim whose cwd is a subdirectory of a worktree still resolves', async () => {
  const { service } = build(seedWithWorktrees());

  // `file_path` was relative, resolved against the entry's own cwd one level
  // down — and the result still folds against the worktree it is inside.
  const claims = await service.claimsFor(
    PROJECT, [`${M1_RAIL}/src/d.ts`], [PROJECT, AGENT_A, M1_RAIL]);

  assert.deepEqual(claims.get(`${M1_RAIL}/src/d.ts`)?.sessions.map(s => s.sessionId),
    [SESSION_FOUR]);
});

test('the same relative path in another project does not cross over', async () => {
  const { service } = build(seedWithWorktrees());

  const claims = await service.claimsFor(
    PROJECT, [`${M1_RAIL}/src/a.ts`], [PROJECT, AGENT_A, M1_RAIL]);
  const sessions = claims.get(`${M1_RAIL}/src/a.ts`)?.sessions.map(s => s.sessionId) ?? [];

  // `/home/test/other/src/a.ts` — a project of its own, never in the pool.
  assert.equal(sessions.includes('11111111-1111-4111-8111-111111111111'), false);
  // `<project>/vendor/other/src/a.ts` — read, because it sits inside the
  // project directory, but never folded: a session merely having run somewhere
  // does not make that place a checkout of this repository, so its claim keeps
  // the `vendor/other/` that tells it apart.
  assert.equal(sessions.includes('33333333-3333-4333-8333-333333333333'), false);

  const nested = await service.claimsFor(
    PROJECT, [`${PROJECT}/vendor/other/src/a.ts`], [PROJECT, AGENT_A, M1_RAIL]);
  assert.deepEqual(nested.get(`${PROJECT}/vendor/other/src/a.ts`)?.sessions.map(s => s.sessionId),
    ['33333333-3333-4333-8333-333333333333'], 'and it is still attributed to itself');
});

test('without a checkout list the CLI worktree layout is still folded', async () => {
  const { service } = build(seedWithWorktrees());

  // git could not be asked — not a repository from here, or the command failed.
  // A session's own cwd still says `<project>/.claude/worktrees/<name>`, which
  // is a shape rather than a guess, so a question about that worktree resolves.
  const claims = await service.claimsFor(PROJECT, [`${AGENT_A}/src/a.ts`]);

  assert.deepEqual(claims.get(`${AGENT_A}/src/a.ts`)?.sessions.map(s => s.sessionId),
    [SESSION_THREE, SESSION_TWO, SESSION_ONE]);
});

test('a single-checkout project answers exactly as it did before', async () => {
  const { service } = build(seed());

  // No worktrees anywhere: the fold is to the project directory on both sides,
  // and the answer is the one the first test in this file asserts.
  const withList = await service.claimsFor(PROJECT, ['src/a.ts'], [PROJECT]);
  const without = await service.claimsFor(PROJECT, ['src/a.ts']);

  assert.deepEqual(withList, without);
  assert.deepEqual(withList.get('src/a.ts')?.sessions, [
    { sessionId: SESSION_TWO, lastAtIso: '2026-08-13T09:00:00.000Z', edits: 1 },
    { sessionId: SESSION_ONE, lastAtIso: '2026-08-12T12:00:00.000Z', edits: 1 },
  ]);
});
