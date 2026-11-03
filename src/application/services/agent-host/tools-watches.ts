/**
 * `watch-dir` and `unwatch-dir`: a VM working tree, watched for the Mac (#276
 * stage 4, #296).
 *
 * The Mac's session work page and project page refresh when a worktree's git
 * state moves. Locally that is `GitCliWorkspace.watch`; for a VM worktree the
 * Mac asks here instead, and this pushes `dir-changed {watchId}` whenever the
 * Mac would have been called back locally.
 *
 * ## What is watched
 *
 * The same as the Mac watches, and for the same reason (the GitWorkspace
 * port's `watch`: "HEAD, index or refs; edits nothing has staged are not
 * reported"): the worktree's git dir (HEAD, index), the common dir it shares
 * with the main checkout (packed-refs), and the common dir's `refs`
 * recursively. Watching the whole working tree recursively would cost an
 * inotify watch per folder in it, `node_modules` included: tens of thousands
 * on a JavaScript project, past the per-user limit that every editor and dev
 * server on the box shares. `refs` is a few folders.
 *
 * Node 22, which the agent ships with, supports `recursive` on Linux (since
 * 19.1, emulated with one inotify watch per folder), so `refs` is watched
 * recursively there; the adapter falls back to `refs/heads` alone where it
 * can't. Every git run the Mac asks for is made with `GIT_OPTIONAL_LOCKS=0`,
 * so its own `git status` never rewrites the index and sets off this watch.
 *
 * ## Polling
 *
 * When the folder can't be watched at all (it is not a checkout with a `.git`
 * on disk, inotify's watch limit is hit, an odd filesystem), or a watch breaks
 * later, the watch polls instead: `git status --porcelain=v2 --branch` every
 * WATCH_POLL_MS, and a changed answer counts as a change. That answer moves
 * with HEAD, the branch, the index and the working files, so a polled watch
 * hears of a little more than an inotify one does, never less.
 *
 * ## Debounce
 *
 * A commit or a rebase touches many files at once. The first change starts a
 * WATCH_DEBOUNCE_MS timer and the push goes when it fires, covering every
 * change in between. As in the transcripts part, later changes don't restart
 * it, so a tree that never settles is still pushed.
 *
 * A watch belongs to the client that asked: it stops on `unwatch-dir`, and
 * every one a client holds stops when it goes. A client holds at most
 * MAX_WATCHES_PER_CLIENT; past that, a new watch is refused (logged, as
 * `watch-dir` has no answer) rather than growing without bound.
 */
import type {ClientLink} from '../../ports/agent-link';
import type {TimerHandle, Timers} from '../../ports/clock';
import type {Logger} from '../../ports/logger';

// ── Ports ──

/** One working tree being watched. */
export interface TreeWatch {
    close(): void;
}

/** Watches a working tree's git state: its HEAD, index and refs. */
export interface TreeWatcher {
    /**
     * Call `onChange` whenever the tree's git state may have moved, and
     * `onError` once if the watch breaks. Null when the tree can't be watched
     * at all; the caller polls it instead.
     */
    watch(dir: string, onChange: () => void, onError: () => void): TreeWatch | null;
}

/** What a poll asks: a fingerprint of the tree's state, or null when it can't be read. */
export type TreeFingerprint = (dir: string) => Promise<string | null>;

// ── Limits ──

/** How long after a tree's first change its push goes. A round trip to the Mac costs more than this. */
export const WATCH_DEBOUNCE_MS = 300;

/** How often a tree that can't be watched is polled. */
export const WATCH_POLL_MS = 3000;

/** The most watches one client may hold: a few open pages' worth of worktrees, with room to spare. */
export const MAX_WATCHES_PER_CLIENT = 64;

export interface WatchesDeps {
    watcher: TreeWatcher;
    fingerprint: TreeFingerprint;
    timers: Timers;
    log: Logger;
    /** Override WATCH_DEBOUNCE_MS, for tests. */
    debounceMs?: number;
    /** Override WATCH_POLL_MS, for tests. */
    pollMs?: number;
}

/** One watch a client asked for. */
interface Watch {
    client: ClientLink;
    watchId: string;
    dir: string;
    /** The inotify watch; null while the tree is polled. */
    watch: TreeWatch | null;
    /** The pending push. */
    debounce: TimerHandle;
    /** The next poll, while polled. */
    poll: TimerHandle;
    /** The last poll's fingerprint; undefined before the first. */
    last: string | null | undefined;
    stopped: boolean;
}

export class Watches {
    /** Each client's watches, by watch id. */
    private readonly byClient = new Map<ClientLink, Map<string, Watch>>();

    constructor(private readonly deps: WatchesDeps) {}

    /** Watch `dir` (absolute) for `client` as `watchId`, replacing a watch it already had by that id. */
    public start(client: ClientLink, watchId: string, dir: string): void {
        let watches = this.byClient.get(client);
        if (!watches) {
            watches = new Map();
            this.byClient.set(client, watches);
        }
        const existing = watches.get(watchId);
        if (existing) {
            this.stop(existing);
            watches.delete(watchId);
        }
        if (watches.size >= MAX_WATCHES_PER_CLIENT) {
            this.deps.log.warn(`agent: watch refused, the client already holds ${MAX_WATCHES_PER_CLIENT}: ${dir}`);
            return;
        }
        const watch: Watch = {
            client,
            watchId,
            dir,
            watch: null,
            debounce: null,
            poll: null,
            last: undefined,
            stopped: false,
        };
        watches.set(watchId, watch);
        watch.watch = this.deps.watcher.watch(
            dir,
            () => this.changed(watch),
            () => this.broke(watch),
        );
        if (!watch.watch) {
            this.deps.log.info(`agent: polling ${dir}, it can't be watched`);
            void this.pollOnce(watch);
        }
    }

    /** Stop `client`'s watch `watchId`; an unknown id is fine. */
    public end(client: ClientLink, watchId: string): void {
        const watches = this.byClient.get(client);
        const watch = watches?.get(watchId);
        if (!watches || !watch) return;
        this.stop(watch);
        watches.delete(watchId);
        if (watches.size === 0) this.byClient.delete(client);
    }

    /** Every watch the client held stops. */
    public clientGone(client: ClientLink): void {
        const watches = this.byClient.get(client);
        if (!watches) return;
        for (const watch of watches.values()) this.stop(watch);
        this.byClient.delete(client);
    }

    /** How many watches are open now, for tests and logs. */
    public get count(): number {
        let n = 0;
        for (const watches of this.byClient.values()) n += watches.size;
        return n;
    }

    private stop(watch: Watch): void {
        watch.stopped = true;
        watch.watch?.close();
        watch.watch = null;
        this.deps.timers.clearTimeout(watch.debounce);
        this.deps.timers.clearTimeout(watch.poll);
        watch.debounce = null;
        watch.poll = null;
    }

    /** Something moved: push once the burst settles. */
    private changed(watch: Watch): void {
        if (watch.stopped || watch.debounce) return;
        watch.debounce = this.deps.timers.setTimeout(() => {
            watch.debounce = null;
            if (watch.stopped || watch.client.closed) return;
            watch.client.send({type: 'dir-changed', watchId: watch.watchId});
        }, this.deps.debounceMs ?? WATCH_DEBOUNCE_MS);
    }

    /** The watch broke (its folder deleted, say): poll from here on, and count it as a change. */
    private broke(watch: Watch): void {
        if (watch.stopped) return;
        watch.watch = null;
        this.deps.log.info(`agent: the watch on ${watch.dir} broke, polling it`);
        this.changed(watch);
        void this.pollOnce(watch);
    }

    /**
     * One poll, then the next one armed. A poll is armed only after the last
     * one answered, so a slow `git status` never piles up behind itself.
     */
    private async pollOnce(watch: Watch): Promise<void> {
        if (watch.stopped) return;
        const now = await this.deps.fingerprint(watch.dir);
        if (watch.stopped) return;
        // The first answer is the baseline, not a change.
        if (watch.last !== undefined && now !== watch.last) this.changed(watch);
        watch.last = now;
        watch.poll = this.deps.timers.setTimeout(() => {
            watch.poll = null;
            void this.pollOnce(watch);
        }, this.deps.pollMs ?? WATCH_POLL_MS);
    }
}
