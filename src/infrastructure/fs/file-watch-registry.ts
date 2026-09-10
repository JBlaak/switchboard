/**
 * Watching individual files the renderer has on screen.
 *
 * Separate from the projects watcher because the question is different: there,
 * "which project changed"; here, "the file on screen changed on disk, say so".
 * One `fs.watch` per path however many surfaces asked for it — and that is why
 * the count matters. There are several askers now: every viewer panel, and the
 * whole-worktree diff, which watches the sections it has drawn so it can dim
 * one that goes stale. They watch the same file constantly, because the file
 * you opened is the file you opened it *from* the diff.
 *
 * So a watch is reference-counted. Without the count the second asker's
 * `watch` is a no-op that still hands out a promise of events, and the first
 * asker's `unwatch` then closes a watcher the second one is relying on — a
 * panel that silently stops live-reloading, with nothing on screen to say it
 * has. Counting is the whole fix: the handle is opened on the first ask and
 * closed on the last release.
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

/** One open handle, and how many callers are relying on it. */
interface CountedWatch {
  watcher: Watcher;
  callers: number;
}

export class FileWatchRegistry {
  readonly #watchers = new Map<string, CountedWatch>();

  constructor(private readonly deps: FileWatchRegistryDeps) {}

  watch(filePath: string): { ok: boolean; error?: string } {
    const { fs, timers, onChanged } = this.deps;
    const resolved = fs.resolve(filePath);
    const open = this.#watchers.get(resolved);
    if (open) {
      open.callers += 1;
      return { ok: true };
    }

    try {
      let debounce: unknown = null;
      const watcher = fs.watch(resolved, {}, (eventType) => {
        if (eventType !== 'change') return;
        timers.clearTimeout(debounce);
        debounce = timers.setTimeout(() => onChanged(resolved), DEBOUNCE_MS);
      });
      this.#watchers.set(resolved, { watcher, callers: 1 });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** Release one caller's interest. The handle closes when the last one goes. */
  unwatch(filePath: string): void {
    const resolved = this.deps.fs.resolve(filePath);
    const open = this.#watchers.get(resolved);
    if (!open) return;
    open.callers -= 1;
    if (open.callers > 0) return;
    open.watcher.close();
    this.#watchers.delete(resolved);
  }

  closeAll(): void {
    for (const { watcher } of this.#watchers.values()) watcher.close();
    this.#watchers.clear();
  }
}
