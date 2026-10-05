/**
 * The full-text index over sessions.
 */
import type { SearchEntry, SearchResult, SearchType } from '../../domain/search/search';

export interface SearchIndex {
  /** False on a first launch, or after the index was dropped and recreated. */
  isPopulated(): boolean;
  /**
   * True when a migration rebuilt the index's storage, so it holds nothing and
   * a full re-index is owed regardless of what the session cache says.
   */
  wasRecreated(): boolean;
  upsert(entries: readonly SearchEntry[]): void;
  deleteSession(sessionId: string): void;
  deleteFolder(folder: string): void;
  /** Updates just the title, for a rename that leaves the body alone. */
  updateTitle(id: string, type: SearchType, title: string): void;
  query(type: SearchType, query: string, limit: number, titleOnly: boolean): SearchResult[];
}
