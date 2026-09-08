/**
 * Domain types shared by the main process, the preload bridge and the renderer.
 *
 * These describe what actually crosses the IPC boundary, so they are the one
 * place where the shape of a session or a project is stated. Anything that only
 * one side cares about belongs next to that side instead.
 */

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

/** User-controlled per-session state, stored in SQLite rather than the transcript. */
export interface SessionMeta {
  sessionId: string;
  name: string | null;
  starred: 0 | 1;
  archived: 0 | 1;
}

/** A `session_cache` row: `Session` minus the fields too large to keep in SQLite. */
export type CachedSession = Omit<Session, 'textContent' | 'customTitle'>;

/** A `cache_meta` row — the per-folder gate that decides if a rescan is needed. */
export interface FolderMeta {
  folder: string;
  /** NULL for a folder that has been scanned but holds no resolvable project. */
  projectPath: string | null;
  indexMtimeMs: number;
}

/** The result of scanning one project folder off the filesystem. */
export interface FolderScan {
  folder: string;
  projectPath: string;
  sessions: Session[];
  indexMtimeMs: number;
}

/** SSH coordinates for a project that lives on another host. */
export interface RemoteConfig {
  user: string;
  host: string;
  port: number;
  /** Absent or null when the remote should land in the login home. */
  dir?: string | null;
}

/** A project: a directory with sessions in it, local or remote. */
export interface Project {
  projectPath: string;
  folder: string;
  sessions: SessionRow[];
  /** True for ssh:// projects, whose sessions live on the far host. */
  remote?: boolean;
}

/**
 * A session as the sidebar renders it — the cache row plus its user metadata.
 *
 * `starred`/`archived` are numbers rather than booleans because they come
 * straight out of SQLite as integers, and every reader treats them as truthy.
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

/** A remote project as stored in the `global` settings blob. */
export interface RemoteProjectSetting extends RemoteConfig {
  sessions?: RemoteSessionRecord[];
}

/**
 * The `global` settings blob. Open-ended on purpose: the settings panel writes
 * arbitrary per-feature keys, and only the ones read here need to be named.
 */
export interface GlobalSettings {
  hiddenProjects?: string[];
  remoteProjects?: RemoteProjectSetting[];
  [key: string]: unknown;
}

export type SearchType = 'session' | 'plan' | 'memory';

/** A row queued for the FTS5 index. */
export interface SearchEntry {
  id: string;
  type: SearchType;
  folder?: string | null;
  title?: string;
  body?: string;
}

export interface SearchResult {
  id: string;
  /** FTS5 `snippet()` output — contains `<mark>` tags, so it is trusted HTML. */
  snippet: string;
}

/** How a terminal session was started; decides which transport main uses. */
export type SessionKind = 'claude' | 'terminal' | 'remote';

/**
 * How a session should be launched, as the renderer assembles it and the main
 * process reads it. Open-ended: the settings panel can add flags either side
 * knows nothing about yet.
 */
export interface SessionOptions {
  type?: string;
  remoteKind?: string;
  shell?: string;
  /** The session this one is forked from, while the fork is unresolved. */
  forkFrom?: string;
  dangerouslySkipPermissions?: boolean;
  permissionMode?: string | null;
  worktree?: boolean;
  worktreeName?: string;
  chrome?: boolean;
  preLaunchCmd?: string;
  addDirs?: string;
  mcpEmulation?: boolean;
  [key: string]: unknown;
}

export type RemotePhase = 'connecting' | 'connected' | 'retrying' | 'disconnected' | 'failed';

/**
 * Connection state for a remote session, as main sends it over IPC.
 *
 * Which fields are populated depends on the phase — `retrying` carries the
 * backoff, `failed` carries how many attempts were spent — so they are all
 * optional rather than split into a union the render helpers would have to
 * narrow at every use.
 */
export interface RemoteStatusPayload {
  phase: RemotePhase;
  /** "user@host" — what the card shows you are connecting to. */
  target?: string;
  reason?: string;
  attempt?: number;
  maxAttempts?: number;
  /** Total attempts spent, sent with `failed`. */
  attempts?: number;
  /** How long until the next dial; the renderer turns this into `retryAt`. */
  delayMs?: number;
  everConnected?: boolean;
}

/**
 * The renderer's stored copy of a status. `delayMs` is a duration measured from
 * whenever main sent it, which is useless for rendering a countdown after the
 * fact, so on receipt it is resolved against the local clock into `retryAt`.
 */
export interface RemoteStatusView extends RemoteStatusPayload {
  retryAt?: number;
  /** When this connect attempt began locally, for the card's elapsed counter. */
  startedAt?: number;
}
