/**
 * The directory Claude CLI keeps its transcripts in.
 *
 * `~/.claude/projects/<folder>/<sessionId>.jsonl` is not ours to write — the CLI
 * owns it — so this port is mostly reads, plus the two writes Switchboard does
 * make: creating a folder when the user adds a project, and seeding a
 * transcript so a session exists before the CLI has run.
 *
 * Everything is keyed by folder and session id rather than by path, so nothing
 * above this has to know the layout.
 */
import type { Session } from '../../domain/session/session';
import type { TranscriptEntry } from '../../domain/session/transcript';

/** The identifiers a seeded transcript is written with. */
export interface TranscriptSeed {
  sessionId: string;
  messageId: string;
  nowIso: string;
}

/** Where a transcript folder's sessions belong, and where they ran. */
export interface ResolvedProject {
  /** The project to attribute the sessions to: a worktree's parent repository. */
  projectPath: string;
  /** The directory the sessions actually ran in; equals projectPath outside a worktree. */
  cwd: string;
}

export interface TranscriptStore {
  /** Every project folder, excluding the ones that are not projects. */
  listFolders(): string[];
  folderExists(folder: string): boolean;

  /** The session ids with a transcript in this folder. */
  listSessionIds(folder: string): string[];

  /**
   * The project this folder's transcripts say they belong to, and the
   * directory they actually ran in.
   *
   * Both read out of a transcript's `cwd` rather than decoded from the folder
   * name, which is lossy. `projectPath` folds a worktree into the repository it
   * was cut from, which is right for grouping; `cwd` is the raw directory, kept
   * because that fold is exactly what a list scoped to one worktree has to
   * undo. Null when the folder holds nothing readable.
   */
  resolveProjectPath(folder: string): ResolvedProject | null;

  /**
   * The newest write anywhere in the folder, as epoch ms.
   *
   * The gate the incremental re-index turns on: cheap (stat only) and correct
   * even though transcripts are appended in place, which often leaves the
   * containing directory's own mtime untouched.
   */
  folderIndexMtimeMs(folder: string): number;

  /** The file mtime a cached row would be invalidated against. Null if gone. */
  sessionFingerprint(folder: string, sessionId: string): string | null;

  /** Parse one transcript, or null when it holds no conversation. */
  readSession(folder: string, sessionId: string, projectPath: string): Session | null;

  /** Every entry of a transcript, for the message-history viewer. */
  readEntries(folder: string, sessionId: string): TranscriptEntry[];

  /** The leading lines of a transcript, for the cheap signal reads. */
  readHeadLines(folder: string, sessionId: string, byteLimit: number): string[];

  /** The trailing bytes of a transcript, for the plan-handover check. */
  readTail(folder: string, sessionId: string, byteLimit: number): string;

  /** A transcript's own mtime in epoch ms, for the handover timing check. */
  sessionMtimeMs(folder: string, sessionId: string): number | null;

  /** The `slug` a session was started under, if it has one. */
  readSlug(folder: string, sessionId: string): string | null;

  /**
   * Create the folder for a project, seeding a transcript when it has none.
   *
   * The seed is not decoration: `resolveProjectPath` reads a project path out
   * of a transcript's `cwd`, so a folder with no transcripts cannot be resolved
   * back to its project and the project would vanish from the sidebar again.
   *
   * Answers with the folder name.
   */
  ensureProjectFolder(projectPath: string, seed: TranscriptSeed): string;

  /**
   * Write a transcript for a session that has not run yet.
   *
   * Used by the scheduler and the schedule creator, which need a session to
   * resume into and a slug to group the runs under.
   */
  seedSession(folder: string, sessionId: string, lines: readonly unknown[]): void;
}
