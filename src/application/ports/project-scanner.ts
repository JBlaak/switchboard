/**
 * The cold-start scan of every transcript on disk.
 *
 * Separate from TranscriptStore because it is the one read that cannot happen
 * on the main thread: a first launch with years of history parses tens of
 * thousands of files, and doing that inline freezes the window before it has
 * painted. The adapter runs it on a worker; the port only promises progress and
 * a result.
 */
import type { FolderScan } from '../../domain/session/session';

export interface ProjectScanner {
  scan(onProgress: (text: string) => void): Promise<FolderScan[]>;
}
