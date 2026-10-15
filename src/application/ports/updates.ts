/**
 * Where new versions come from, and how one is put in place.
 */
import type { PublishedRelease } from '../../domain/update/release';

export interface ReleaseFeed {
  /** The newest published release; null when there is none. Rejects when it cannot be fetched. */
  latest(): Promise<PublishedRelease | null>;
}

export interface AppInstaller {
  /** False when this build cannot replace itself: not packaged, not a Mac, or no write access to its folder. */
  canInstall(): boolean;
  /**
   * Download and unpack the zip, then hand the swap to a helper and quit; the
   * helper puts the new bundle in place and relaunches it. Rejects when any
   * step before the quit fails, leaving the running app untouched.
   */
  install(downloadUrl: string): Promise<void>;
}
