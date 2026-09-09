/**
 * The filesystem, as a dependency.
 *
 * Deliberately synchronous and deliberately small. Synchronous because every
 * caller here is already on the main process's own timeline — the reads are of
 * small files in the user's home directory, and an async version would only add
 * interleaving to code that has to see a consistent directory. Small because
 * the point is to make the services above testable against an in-memory double,
 * not to abstract Node.
 *
 * Path joining lives here too: it is platform behaviour, and keeping it behind
 * the port is what lets the application layer stay free of `node:path`.
 */

export interface DirEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

export interface FileStat {
  /** ISO-8601 mtime. */
  modifiedIso: string;
  /** ISO-8601 birthtime. */
  createdIso: string;
  mtimeMs: number;
  size: number;
}

/** A cancellable filesystem watch. */
export interface Watcher {
  close(): void;
}

export interface WatchOptions {
  recursive?: boolean;
}

/** What a watch reports: the event kind, and the path relative to the target. */
export type WatchListener = (eventType: string, relativePath: string | null) => void;

export interface FileSystem {
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  /** Reads UTF-8, or throws — callers that tolerate a missing file check first. */
  readText(path: string): string;
  writeText(path: string, content: string, options?: { mode?: number }): void;
  /** Reads a slice, for a file too large to hold whole (a long transcript). */
  readSlice(path: string, range: { start: number; length: number }): string;
  readDir(path: string): DirEntry[];
  /** Null when the path does not exist or cannot be read. */
  stat(path: string): FileStat | null;
  makeDir(path: string): void;
  remove(path: string): void;
  rename(from: string, to: string): void;
  watch(path: string, options: WatchOptions, listener: WatchListener): Watcher;

  // Path operations — platform-specific, so they belong to the adapter.
  join(...parts: string[]): string;
  resolve(path: string): string;
  basename(path: string, ext?: string): string;
  dirname(path: string): string;
  /** True when `child` is inside `parent`, for the write-path guards. */
  isInside(parent: string, child: string): boolean;
  readonly separator: string;
  readonly homeDir: string;
}
