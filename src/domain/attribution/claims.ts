/**
 * Reading edit claims out of a transcript.
 *
 * Every file-modifying tool call the CLI makes is written into the session's
 * own `.jsonl`, as an assistant entry carrying a `tool_use` block:
 *
 *     { type: 'assistant', sessionId, timestamp, cwd, gitBranch,
 *       message: { role: 'assistant', content: [
 *         { type: 'tool_use', name: 'Write', input: { file_path: '…' } } ] } }
 *
 * That makes the transcripts a complete record of who asked to change what —
 * complete regardless of permission mode, with IDE emulation off, and across
 * history rather than only since the app launched, none of which is true of the
 * MCP bridge's `openDiff`. What it is not is a record of what *landed*: a
 * rejected diff or a later revert leaves the claim behind, so a consumer
 * intersects the answer with `git status` (see `claimsForPaths`).
 *
 * Pure, and tolerant on purpose. A transcript is a foreign format being
 * appended to as it is read, so the last line is routinely half-written and
 * every field is treated as best-effort: a line that will not parse, or an
 * entry shaped differently than expected, contributes nothing rather than
 * throwing.
 */
import { parseTranscriptLine } from '../session/transcript';
import type { EditClaim, PathClaims, SessionClaim } from './types';

/**
 * The tools that change a file on disk.
 *
 * `Read`, `Bash` and every MCP tool are deliberately absent: a `Bash` call can
 * of course write a file, but its `input` is a command line rather than a path,
 * so there is nothing to attribute. Measured over 136,809 real entries, only
 * `Write` and `Edit` actually occur; the other two are here because the CLI
 * emits them and their absence would be a silent miss.
 */
export const FILE_MODIFYING_TOOLS: readonly string[] = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

const FILE_TOOLS = new Set(FILE_MODIFYING_TOOLS);

/**
 * Every claim one transcript line makes — one per file-modifying `tool_use`.
 *
 * A single assistant turn can call `Edit` several times, so a line yields a
 * list rather than at most one claim.
 */
export function claimsFromTranscriptLine(line: string): EditClaim[] {
  return claimsFromEntry(parseTranscriptLine(line));
}

/**
 * The same, for a caller that already holds the parsed entry.
 *
 * Takes `unknown` because the entry type the session parser exposes describes
 * only the fields the sidebar needs — the `tool_use` blocks are narrowed here
 * instead, structurally, which is what keeps a cast out of both files.
 *
 * A subagent's entry (`isSidechain: true`) is kept, and is not a special case:
 * measured, it carries the *parent* session's `sessionId`, so the edits a
 * spawned agent makes attribute to the session that spawned it — which is the
 * answer the UI wants anyway.
 */
export function claimsFromEntry(entry: unknown): EditClaim[] {
  const record = asRecord(entry);
  const message = asRecord(record?.message);
  if (!record || !message) return [];

  // A tool call is the assistant's turn. The matching `user` entry carries the
  // tool *result*, and counting that too would double every edit.
  if (record.type !== 'assistant' && message.role !== 'assistant') return [];

  const content = message.content;
  if (!Array.isArray(content)) return [];

  const sessionId = asString(record.sessionId);
  if (!sessionId) return [];
  const atIso = asString(record.timestamp) ?? '';
  const cwd = asString(record.cwd);

  const claims: EditClaim[] = [];
  for (const block of content) {
    const used = asRecord(block);
    if (!used || used.type !== 'tool_use') continue;
    const tool = asString(used.name);
    if (!tool || !FILE_TOOLS.has(tool)) continue;

    const input = asRecord(used.input);
    // `NotebookEdit` names its target `notebook_path`; everything else
    // `file_path`. Both are read for either tool, because which key a future
    // tool uses is the CLI's business and a miss here is a missing group in
    // the UI.
    const claimed = asString(input?.file_path) ?? asString(input?.notebook_path);
    if (!claimed) continue;

    const path = resolveClaimPath(cwd, claimed);
    if (path) claims.push({ sessionId, path, atIso, tool });
  }
  return claims;
}

/**
 * Fold claims into one entry per path, sessions most recent first.
 *
 * Two sessions on one file is routine rather than hypothetical — 10 of one
 * project's 60 most-edited paths had more than one — so every session that
 * touched a path is kept, not just the last.
 *
 * Timestamps are ISO-8601 UTC, which compares chronologically as a string.
 * Sessions that tie are ordered by id, so the same input always renders the
 * same way.
 */
export function groupClaims(claims: readonly EditClaim[]): Map<string, PathClaims> {
  const perPath = new Map<string, Map<string, SessionClaim>>();

  for (const claim of claims) {
    let sessions = perPath.get(claim.path);
    if (!sessions) perPath.set(claim.path, sessions = new Map());
    const known = sessions.get(claim.sessionId);
    if (!known) {
      sessions.set(claim.sessionId, {
        sessionId: claim.sessionId,
        lastAtIso: claim.atIso,
        edits: 1,
      });
    } else {
      known.edits++;
      if (claim.atIso > known.lastAtIso) known.lastAtIso = claim.atIso;
    }
  }

  const grouped = new Map<string, PathClaims>();
  for (const [path, sessions] of perPath) {
    grouped.set(path, { path, sessions: [...sessions.values()].sort(byRecency) });
  }
  return grouped;
}

/**
 * The intersection with what git says actually changed.
 *
 * This is where a claim on a file that was rejected, reverted or written and
 * then written back is dropped: the transcript still remembers it, the working
 * tree does not, and the working tree is right. Both sides are absolute paths;
 * a caller holding paths relative to a worktree resolves them first.
 */
export function claimsForPaths(
  byPath: ReadonlyMap<string, PathClaims>,
  paths: readonly string[],
): Map<string, PathClaims> {
  const wanted = new Map<string, PathClaims>();
  for (const path of paths) {
    const claims = byPath.get(path);
    if (claims) wanted.set(path, claims);
  }
  return wanted;
}

/**
 * The absolute path a claim is about.
 *
 * Every observed `file_path` was already absolute, but the entry's own `cwd` is
 * not always the project root — one session in the measured project ran in
 * `src/renderer` — so a relative path has to be resolved against the entry that
 * carried it rather than against the project. Windows paths keep their
 * separator: these strings are compared against git's output and shown to the
 * user, not passed to `path.join`.
 */
export function resolveClaimPath(cwd: string | null | undefined, filePath: string): string {
  if (!filePath) return '';
  const base = cwd ?? '';
  const rooted = isAbsolutePath(filePath);
  const windows = looksWindows(rooted ? filePath : base);
  const separator = windows ? '\\' : '/';
  return normalizePath(rooted || !base ? filePath : base + separator + filePath, separator);
}

/** Most recent first, then by id so equal timestamps still have one order. */
function byRecency(a: SessionClaim, b: SessionClaim): number {
  if (a.lastAtIso !== b.lastAtIso) return a.lastAtIso < b.lastAtIso ? 1 : -1;
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
}

function isAbsolutePath(target: string): boolean {
  return target.startsWith('/') || target.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(target);
}

function looksWindows(target: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(target) || target.startsWith('\\\\');
}

/** Fold `.`, `..` and repeated separators away, keeping whatever root there was. */
function normalizePath(target: string, separator: string): string {
  const unc = /^[\\/]{2}/.test(target);
  const drive = /^[A-Za-z]:/.exec(target);
  const rooted = /^[\\/]/.test(target);

  const segments: string[] = [];
  for (const segment of target.split(/[\\/]+/)) {
    if (!segment || segment === '.') continue;
    if (drive && segments.length === 0 && segment === drive[0]) continue;
    if (segment !== '..') {
      segments.push(segment);
    } else if (segments.length && segments[segments.length - 1] !== '..') {
      segments.pop();
    } else if (!rooted && !drive) {
      // A `..` that climbs above a relative base is all that is left of it.
      segments.push('..');
    }
  }

  const prefix = unc ? separator + separator : drive ? drive[0] + separator : rooted ? separator : '';
  return segments.length ? prefix + segments.join(separator) : prefix || '.';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
