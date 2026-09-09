/**
 * What a session is.
 *
 * These types are the shared kernel: the main process, the preload bridge and
 * the renderer all speak in them, so they are the one place the shape of a
 * session is stated. Anything only one side cares about belongs next to that
 * side instead — a live PTY handle, for instance, never appears here.
 */

/** How a terminal session was started; decides which transport main uses. */
export type SessionKind = 'claude' | 'terminal' | 'remote';

/** A session parsed out of a Claude CLI `.jsonl` transcript. */
export interface Session {
  sessionId: string;
  folder: string;
  projectPath: string;
  /** First real user message, truncated — the row label before any rename. */
  summary: string;
  firstPrompt: string;
  /** ISO-8601. First message timestamp, falling back to the file's birthtime. */
  created: string;
  /** ISO-8601. Last message timestamp, falling back to the file's mtime. */
  modified: string;
  /**
   * ISO-8601 file mtime. Cache-invalidation key only — never a display value.
   * Resuming a session appends untimestamped bookkeeping records, which move
   * the mtime without any real activity, which is why `modified` is separate.
   */
  fileMtime: string;
  messageCount: number;
  /** Concatenated message text, capped at 8000 chars, for the search index. */
  textContent?: string;
  slug: string | null;
  customTitle: string | null;
  aiTitle: string | null;
}

/** User-controlled per-session state, stored outside the transcript. */
export interface SessionMeta {
  sessionId: string;
  name: string | null;
  starred: 0 | 1;
  archived: 0 | 1;
}

/** A cached session: `Session` minus the fields too large to keep in the cache. */
export type CachedSession = Omit<Session, 'textContent' | 'customTitle'>;

/** The per-folder gate that decides whether a rescan is needed. */
export interface FolderMeta {
  folder: string;
  /** NULL for a folder that has been scanned but holds no resolvable project. */
  projectPath: string | null;
  /**
   * The directory this folder's transcripts ran in. Equals projectPath unless
   * that is a worktree folded into the repository it was cut from — the fold
   * is right for grouping and wrong for scoping, so both are kept. A folder is
   * one cwd, which is why this lives on the gate rather than on every row.
   * NULL for a gate written before the column existed (backfilled lazily by the
   * project list) or for a folder with no readable transcript.
   */
  cwd: string | null;
  indexMtimeMs: number;
}

/** The result of scanning one project folder off the filesystem. */
export interface FolderScan {
  folder: string;
  projectPath: string;
  /** The raw cwd `projectPath` was resolved from; see FolderMeta.cwd. */
  cwd: string | null;
  sessions: Session[];
  indexMtimeMs: number;
}

/**
 * A session as the sidebar renders it — the cache row plus its user metadata.
 *
 * `starred`/`archived` are numbers rather than booleans because they come
 * straight out of the store as integers, and every reader treats them as truthy.
 */
export interface SessionRow {
  sessionId: string;
  summary: string;
  firstPrompt: string;
  projectPath: string;
  created: string;
  modified: string;
  messageCount: number;
  slug?: string | null;
  aiTitle?: string | null;
  /**
   * The directory the session ran in — what a list scoped to one worktree
   * filters on. Equals projectPath unless the session ran in a worktree, which
   * projectPath folds into the parent repository. Null when its folder was
   * indexed before the cwd was recorded or carried none; absent on rows that
   * never touched disk (pending, terminal, remote). Readers fall back to
   * projectPath in both cases.
   */
  cwd?: string | null;
  name: string | null;
  starred: number;
  archived: number;
  /** Absent for ordinary Claude sessions read off disk. */
  type?: SessionKind;
  remoteKind?: string;
}

/** One tmux session Switchboard opened on a remote host. */
export interface RemoteSessionRecord {
  sessionId: string;
  kind: string;
  created: string;
  lastOpened?: string;
}

/**
 * Assemble the row the sidebar renders from a cache row and its metadata.
 *
 * `cwd` comes from the folder gate rather than the row: a transcript folder is
 * one directory, so it is recorded once per folder and stamped on here.
 */
export function toSessionRow(
  cached: CachedSession,
  meta: SessionMeta | null | undefined,
  cwd: string | null,
): SessionRow {
  return {
    sessionId: cached.sessionId,
    summary: cached.summary,
    firstPrompt: cached.firstPrompt,
    created: cached.created,
    modified: cached.modified,
    messageCount: cached.messageCount,
    projectPath: cached.projectPath,
    cwd,
    slug: cached.slug || null,
    aiTitle: cached.aiTitle || null,
    name: meta?.name || null,
    starred: meta?.starred || 0,
    archived: meta?.archived || 0,
  };
}

/** Most recently modified first — the order every session list is built in. */
export function byMostRecentlyModified(
  a: { modified: string },
  b: { modified: string },
): number {
  return new Date(b.modified).getTime() - new Date(a.modified).getTime();
}
