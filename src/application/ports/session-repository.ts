/**
 * Where sessions are remembered between launches.
 *
 * Two things are stored, and they have different owners. The *cache* is a copy
 * of what the transcripts on disk say, and can be thrown away and rebuilt at
 * any time. The *metadata* — a rename, a star, an archive — exists nowhere else
 * and must survive a re-index. They share a port because they share a
 * transaction boundary in the adapter, but nothing above it may confuse them.
 */
import type { CachedSession, FolderMeta, SessionMeta } from '../../domain/session/session';
import type { IssuePlanPin, PlanPin } from '../../domain/project/project-list';

export interface SessionRepository {
  // ── Metadata: the user's own state, which no re-index may touch ──
  getMeta(sessionId: string): SessionMeta | null;
  getAllMeta(): Map<string, SessionMeta>;
  setName(sessionId: string, name: string | null): void;
  /** Flips the star and answers with the value it settled on. */
  toggleStar(sessionId: string): 0 | 1;
  setArchived(sessionId: string, archived: boolean): void;
  /** An ISO time the row stays out of the list until, or null to wake it. */
  setSnoozedUntil(sessionId: string, until: string | null): void;
  /** Every pinned plan, as the project it is in and its slug. */
  getPinnedPlans(): PlanPin[];
  /** Pins or unpins a plan and answers whether it is pinned now. */
  togglePlanPin(projectPath: string, slug: string): boolean;
  /** Every GitHub plan pinned from its page, oldest pin first. */
  getPinnedIssuePlans(): IssuePlanPin[];
  /** Pins or unpins a GitHub plan in a project and answers whether it is pinned now. */
  toggleIssuePlanPin(projectPath: string, repository: string, number: number, title: string): boolean;

  // ── Cache: a rebuildable copy of what the transcripts say ──
  isCachePopulated(): boolean;
  getAllCached(): CachedSession[];
  getCachedSession(sessionId: string): CachedSession | null;
  /** The folder a session's transcript lives in, for locating the file. */
  getCachedFolder(sessionId: string): string | null;
  /**
   * The invalidation keys for one folder: which sessions are cached and what
   * file mtime each was read at. Enough to decide what needs re-reading without
   * loading the rows themselves.
   */
  getCachedFingerprints(folder: string): Pick<CachedSession, 'sessionId' | 'fileMtime'>[];
  upsertCachedSessions(sessions: readonly CachedSession[]): void;
  deleteCachedSession(sessionId: string): void;
  /** Drops the folder's sessions and its index gate together. */
  deleteCachedFolder(folder: string): void;

  // ── The per-folder gate that decides whether a rescan is needed ──
  getAllFolderMeta(): Map<string, FolderMeta>;
  setFolderMeta(folder: string, projectPath: string | null, indexMtimeMs: number): void;
}
