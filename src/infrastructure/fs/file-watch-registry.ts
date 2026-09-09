/**
 * Watching individual files the viewer panel has open.
 *
 * Separate from the projects watcher because the question is different: there,
 * "which project changed"; here, "the file on screen changed on disk, reload
 * it". One watch per path, reference-counted by nothing — the renderer opens
 * and closes them explicitly, and a duplicate watch is a no-op.
 */
import type { FileSystem, Watcher } from '../../application/ports/file-system';
import type { Timers } from '../../application/ports/clock';

/** Editors write in bursts (truncate, then write); wait for them to finish. */
const DEBOUNCE_MS = 300;

export interface FileWatchRegistryDeps {
  fs: FileSystem;
  timers: Timers;
  onChanged(filePath: string): void;
}

export class FileWatchRegistry {
  readonly #watchers = new Map<string, Watcher>();

  constructor(private readonly deps: FileWatchRegistryDeps) {}

  watch(filePath: string): { ok: boolean; error?: string } {
    const { fs, timers, onChanged } = this.deps;
    const resolved = fs.resolve(filePath);
    if (this.#watchers.has(resolved)) return { ok: true };

    try {
      let debounce: unknown = null;
      const watcher = fs.watch(resolved, {}, (eventType) => {
        if (eventType !== 'change') return;
        timers.clearTimeout(debounce);
        debounce = timers.setTimeout(() => onChanged(resolved), DEBOUNCE_MS);
      });
      this.#watchers.set(resolved, watcher);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  unwatch(filePath: string): void {
    const resolved = this.deps.fs.resolve(filePath);
    this.#watchers.get(resolved)?.close();
    this.#watchers.delete(resolved);
  }

  closeAll(): void {
    for (const watcher of this.#watchers.values()) watcher.close();
    this.#watchers.clear();
  }
}
