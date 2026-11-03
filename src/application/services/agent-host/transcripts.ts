/**
 * The VM's transcripts (#276 stage 3, #290): parsed for the Mac's rows and
 * search, watched for changes once asked about, tailed for task detection, and
 * imported for a session's hand-off.
 *
 * The Mac never scans the VM's `~/.claude/projects`. It knows its VM sessions
 * by id and asks for each one (`get-transcript`); the agent parses it here,
 * with the same `parseTranscript` the Mac's own store uses, so a VM row reads
 * exactly like a local one. From then on the agent watches that file and
 * pushes `transcripts-changed` when it moves, and the Mac asks again: one
 * parse per change, never a poll from the Mac over the link.
 *
 * ## How the files are watched
 *
 * `fs.watch` (inotify on Linux) on the *folders* that hold watched files, not
 * on each file and never recursively on the whole projects tree. A folder is
 * one project, so a busy VM needs a handful of watches however many sessions
 * the Mac asks about, far under inotify's per-user limit
 * (`fs.inotify.max_user_watches`, 8192 on older kernels, and shared with every
 * editor and dev server on the box). Node shares one inotify instance per
 * process, so `max_user_instances` is not touched either.
 *
 * A folder event only says "something in here changed", so each watched file
 * there is stat'ed and only one whose mtime or size really moved counts.
 *
 * Polling (a re-armed timer every POLL_MS, only while anything is watched)
 * covers what inotify can't:
 * - a session just launched, whose transcript does not exist yet: its id is
 *   looked for under every project folder each round. Watching every project
 *   folder for that would cost a watch per project ever used on the VM;
 *   a stat per folder every few seconds, only while such an id waits, is cheap.
 * - a folder that can't be watched (the watch limit hit, an odd filesystem):
 *   its files are stat'ed each round instead, and the watch is tried again.
 * - every SWEEP_EVERY rounds, every watched file is stat'ed anyway, so an
 *   event inotify dropped (an overflowed queue, a network filesystem) costs
 *   half a minute of staleness, not a row that never updates.
 *
 * ## Debounce
 *
 * A busy session appends to its transcript many times a second. The first
 * change of a file starts a DEBOUNCE_MS timer, and the push goes when it
 * fires, covering every change in between. The timer is deliberately not
 * restarted by later changes: a session that never stops writing would then
 * never be pushed at all.
 *
 * A session is watched for as long as some client that asked about it is
 * connected. When the last of them goes, so do its timers and, if nothing
 * else needs them, the folder watches.
 */
import {rewriteTranscriptCwd} from '../../../domain/agent/session-handoff';
import {TRANSCRIPT_TEXT_CAP_CHARS} from '../../../domain/agent/protocol';
import type {
    AgentTranscript,
    GetTranscriptMessage,
    ImportTranscriptMessage,
    TranscriptTailMessage,
} from '../../../domain/agent/protocol';
import {encodeProjectPath, worktreeParentPath} from '../../../domain/project/project-path';
import {cwdFromTranscript, parseTranscript} from '../../../domain/session/transcript';
import type {ClientLink} from '../../ports/agent-link';
import type {TimerHandle, Timers} from '../../ports/clock';
import type {Logger} from '../../ports/logger';
import type {TranscriptsMessage, TranscriptsPart} from './handlers';
import {expandHome} from './session-host';

// ── Ports ──

/** What a stat of a transcript says. */
export interface TranscriptFileStat {
    mtimeMs: number;
    size: number;
    /** ISO-8601 mtime, as the Mac's store hands `parseTranscript`. */
    modifiedIso: string;
    /** ISO-8601 birthtime, likewise. */
    createdIso: string;
}

/** The file work on `~/.claude/projects`, on absolute paths. */
export interface TranscriptFiles {
    /** The names of the folders directly in `dir`; [] when it does not exist or can't be read. */
    listFolders(dir: string): string[];
    /** A regular file's stat; null when it is missing or not a file. */
    stat(file: string): TranscriptFileStat | null;
    /** The whole file as UTF-8; null when it can't be read. */
    readText(file: string): string | null;
    /** Replace a file's contents; may throw. */
    writeText(file: string, text: string): void;
    /** `length` bytes from `start`; null when the file can't be read. */
    readSlice(file: string, start: number, length: number): Uint8Array | null;
    /** Whether `path` is a folder. */
    isDirectory(path: string): boolean;
    /** The path with every symlink resolved, or null when it does not exist. */
    realpath(path: string): string | null;
    /**
     * Move a file to `to`, creating its folder (0700), and leave it with
     * `mode`. Never replaces a file already at `to`: throws instead. Works
     * across filesystems (the upload's temp folder may be a tmpfs). May throw.
     */
    moveNoClobber(from: string, to: string, mode: number): void;
    /** Delete a file; a missing one is fine; never throws. */
    remove(file: string): void;
}

/** One folder being watched. */
export interface FolderWatch {
    close(): void;
}

/** Watches a folder's own entries (not recursively). */
export interface FolderWatcher {
    /**
     * Call `onChange` whenever something in `folder` changes, and `onError`
     * once if the watch breaks (the folder deleted, say). Null when the
     * folder can't be watched at all; the caller polls it instead.
     */
    watch(folder: string, onChange: () => void, onError: () => void): FolderWatch | null;
}

/** Where an import takes its file from: the copies part's uploads. */
export interface TranscriptUploads {
    /** A finished, checked upload's file, handed over for good; an error otherwise. */
    take(uploadId: string): {file: string} | {error: string};
}

// ── Limits ──

/** How long after a file's first change its push goes. */
export const TRANSCRIPT_DEBOUNCE_MS = 1000;

/** How often missing ids and unwatchable folders are looked at. */
export const TRANSCRIPT_POLL_MS = 2000;

/** Every this many polls, every watched file is stat'ed too: about 30 s. */
export const SWEEP_EVERY = 15;

/** The most a `transcript-tail` reads: task detection needs the last few turns, not the file. */
export const TAIL_MAX_BYTES = 1024 * 1024;

/**
 * What a session id may look like before it goes into a path. Claude's are
 * UUIDs; this is looser, but has no `/` and no `.`, so `..` and friends can
 * never pick a file outside the projects folder.
 */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Folders under `projects` that are not projects: people version their whole `~/.claude`. */
const NOT_A_PROJECT = new Set(['.git']);

export interface TranscriptsDeps {
    files: TranscriptFiles;
    watcher: FolderWatcher;
    uploads: TranscriptUploads;
    /** The VM user's home folder, for `~` in an import's `dir`. */
    home: string;
    /** `~/.claude/projects`, absolute. */
    projectsDir: string;
    timers: Timers;
    log: Logger;
    /** Overrides TRANSCRIPT_TEXT_CAP_CHARS, for tests. */
    textCapChars?: number;
}

/** Where a session's transcript is. */
interface Found {
    file: string;
    /** Its folder's absolute path. */
    dir: string;
    /** Its folder's name under `projects`, the `folder` of a parsed session. */
    folder: string;
    stat: TranscriptFileStat;
}

/** A session some client asked about. */
interface Watched {
    sessionId: string;
    /** Where its file is; null while it does not exist yet. */
    found: Found | null;
    /** The clients that asked, and get the push. */
    clients: Set<ClientLink>;
    /** The pending push; null when none is. */
    timer: TimerHandle;
}

export class Transcripts implements TranscriptsPart {
    private readonly watched = new Map<string, Watched>();
    /** Each folder that holds a watched file: its watch, or null when it is polled. */
    private readonly folders = new Map<string, FolderWatch | null>();
    private pollTimer: TimerHandle = null;
    private polls = 0;

    constructor(private readonly deps: TranscriptsDeps) {}

    public clientConnected(_client: ClientLink): void {}

    /** Its sessions stop being watched, unless another client asked about them too. */
    public clientGone(client: ClientLink): void {
        for (const [id, watched] of [...this.watched]) {
            watched.clients.delete(client);
            if (watched.clients.size > 0) continue;
            this.deps.timers.clearTimeout(watched.timer);
            this.watched.delete(id);
        }
        this.refreshWatches();
    }

    public handle(client: ClientLink, message: TranscriptsMessage): void {
        switch (message.type) {
            case 'get-transcript':
                return this.getTranscript(client, message);
            case 'transcript-tail':
                return this.tail(client, message);
            case 'import-transcript':
                return this.importTranscript(client, message);
        }
    }

    /** The session ids watched now, for tests and logs. */
    public get watchedIds(): string[] {
        return [...this.watched.keys()];
    }

    // ── get-transcript ──

    private getTranscript(client: ClientLink, message: GetTranscriptMessage): void {
        const {requestId, sessionId} = message;
        const answer = (transcript: AgentTranscript | null) => {
            if (!client.closed) client.send({type: 'transcript', requestId, transcript});
        };
        if (!SESSION_ID.test(sessionId)) return answer(null);

        const found = this.find(sessionId);
        this.watch(client, sessionId, found);
        answer(found ? this.parse(sessionId, found) : null);
    }

    /** `parseTranscript` over the file, as the Mac's store calls it; null when it isn't worth a row. */
    private parse(sessionId: string, found: Found): AgentTranscript | null {
        const text = this.deps.files.readText(found.file);
        if (text === null) return null;
        const lines = text.split('\n').filter(Boolean);
        const cwd = cwdFromTranscript(lines);
        // Without a cwd the session can't be placed in any project.
        if (!cwd) return null;
        // As the Mac's store resolves a folder: a worktree belongs to the repository it was cut from.
        const parent = worktreeParentPath(cwd);
        const projectPath = parent && this.deps.files.isDirectory(parent) ? parent : cwd;
        const session = parseTranscript(
            lines,
            {sessionId, folder: found.folder, projectPath},
            {birthtime: found.stat.createdIso, mtime: found.stat.modifiedIso},
        );
        if (!session) return null;
        const cap = this.deps.textCapChars ?? TRANSCRIPT_TEXT_CAP_CHARS;
        if (session.textContent && session.textContent.length > cap) {
            session.textContent = session.textContent.slice(0, cap);
        }
        return {cwd, mtimeMs: found.stat.mtimeMs, session};
    }

    /**
     * A session's transcript under any project folder: the newest by mtime
     * when there are several (a session resumed in another folder leaves its
     * old file behind).
     */
    private find(sessionId: string): Found | null {
        const {files, projectsDir} = this.deps;
        let best: Found | null = null;
        for (const folder of files.listFolders(projectsDir)) {
            if (NOT_A_PROJECT.has(folder)) continue;
            const dir = `${projectsDir}/${folder}`;
            const file = `${dir}/${sessionId}.jsonl`;
            const stat = files.stat(file);
            if (stat && (!best || stat.mtimeMs > best.stat.mtimeMs)) best = {file, dir, folder, stat};
        }
        return best;
    }

    // ── watching ──

    private watch(client: ClientLink, sessionId: string, found: Found | null): void {
        let watched = this.watched.get(sessionId);
        if (!watched) {
            watched = {sessionId, found, clients: new Set(), timer: null};
            this.watched.set(sessionId, watched);
        }
        // The client is about to read this state, so it is the new baseline.
        watched.found = found;
        watched.clients.add(client);
        this.refreshWatches();
    }

    /** Watch exactly the folders that hold watched files, and poll while anything is watched. */
    private refreshWatches(): void {
        const needed = new Set<string>();
        for (const watched of this.watched.values()) if (watched.found) needed.add(watched.found.dir);

        for (const [dir, watch] of [...this.folders]) {
            if (needed.has(dir)) continue;
            watch?.close();
            this.folders.delete(dir);
        }
        for (const dir of needed) if (!this.folders.has(dir)) this.startWatch(dir);

        if (this.watched.size === 0) {
            this.deps.timers.clearTimeout(this.pollTimer);
            this.pollTimer = null;
        } else if (this.pollTimer === null) {
            this.armPoll();
        }
    }

    /** Watch a folder, or note it as polled when it can't be. */
    private startWatch(dir: string): void {
        let watch: FolderWatch | null = null;
        try {
            watch = this.deps.watcher.watch(
                dir,
                () => this.folderChanged(dir),
                () => {
                    // Broken (the folder went): poll it, and try again on the next round.
                    const broken = this.folders.get(dir);
                    if (!broken) return;
                    broken.close();
                    this.folders.set(dir, null);
                    this.folderChanged(dir);
                },
            );
        } catch (err) {
            this.deps.log.warn(`[transcripts] could not watch ${dir}: ${errorText(err)}`);
        }
        if (!watch) this.deps.log.info(`[transcripts] polling ${dir}`);
        this.folders.set(dir, watch);
    }

    private folderChanged(dir: string): void {
        for (const watched of this.watched.values()) {
            if (watched.found?.dir === dir) this.check(watched);
        }
    }

    /** Stat a watched session's file again; schedule a push when it moved, appeared or went. */
    private check(watched: Watched): void {
        const before = watched.found;
        let now: Found | null = null;
        if (before) {
            const stat = this.deps.files.stat(before.file);
            now = stat ? {...before, stat} : this.find(watched.sessionId);
        } else {
            now = this.find(watched.sessionId);
        }
        const moved =
            (before === null) !== (now === null) ||
            (before !== null &&
                now !== null &&
                (before.file !== now.file ||
                    before.stat.mtimeMs !== now.stat.mtimeMs ||
                    before.stat.size !== now.stat.size));
        if (!moved) return;
        watched.found = now;
        this.schedulePush(watched);
        if (before?.dir !== now?.dir) this.refreshWatches();
    }

    /** Start the debounce, unless one is already running: see the module comment. */
    private schedulePush(watched: Watched): void {
        if (watched.timer !== null) return;
        watched.timer = this.deps.timers.setTimeout(() => {
            watched.timer = null;
            if (this.watched.get(watched.sessionId) !== watched) return;
            for (const client of watched.clients) {
                if (!client.closed) client.send({type: 'transcripts-changed', sessionIds: [watched.sessionId]});
            }
        }, TRANSCRIPT_DEBOUNCE_MS);
    }

    private armPoll(): void {
        this.pollTimer = this.deps.timers.setTimeout(() => {
            this.pollTimer = null;
            this.poll();
            if (this.watched.size > 0 && this.pollTimer === null) this.armPoll();
        }, TRANSCRIPT_POLL_MS);
    }

    /** One polling round: missing ids, polled folders, and now and then everything. */
    private poll(): void {
        this.polls++;
        const sweep = this.polls % SWEEP_EVERY === 0;
        for (const [dir, watch] of [...this.folders]) {
            if (watch === null) {
                this.folders.delete(dir);
                this.startWatch(dir);
            }
        }
        const polled = new Set([...this.folders].filter(([, watch]) => watch === null).map(([dir]) => dir));
        for (const watched of [...this.watched.values()]) {
            const dir = watched.found?.dir;
            if (!dir || sweep || polled.has(dir)) this.check(watched);
        }
    }

    // ── transcript-tail ──

    /**
     * The file's last `bytes` (at most TAIL_MAX_BYTES) as whole lines. The
     * byte before the slice is read too, so a slice that starts exactly on a
     * line keeps that line, and one that starts mid-line drops it: that line,
     * and a UTF-8 character cut in half with it, would not parse.
     */
    private tail(client: ClientLink, message: TranscriptTailMessage): void {
        const {requestId, sessionId} = message;
        const answer = (lines: string[]) => {
            if (!client.closed) client.send({type: 'transcript-tail', requestId, lines});
        };
        const wanted = Number.isFinite(message.bytes) ? Math.floor(message.bytes) : 0;
        const bytes = Math.min(Math.max(wanted, 0), TAIL_MAX_BYTES);
        if (!SESSION_ID.test(sessionId) || bytes === 0) return answer([]);
        const found = this.find(sessionId);
        if (!found) return answer([]);

        const size = found.stat.size;
        const start = Math.max(size - bytes, 0);
        const from = Math.max(start - 1, 0);
        const slice = this.deps.files.readSlice(found.file, from, size - from);
        if (!slice) return answer([]);
        let body = slice;
        if (start > 0) {
            const newline = slice.indexOf(0x0a);
            if (newline === -1) return answer([]);
            body = slice.subarray(newline + 1);
        }
        answer(new TextDecoder().decode(body).split('\n').filter(Boolean));
    }

    // ── import-transcript ──

    /**
     * Put an uploaded transcript where `claude --resume` in `dir` finds it.
     * Refused when a transcript of that id exists anywhere under projects:
     * the VM has its own copy of that conversation, and overwriting it could
     * lose turns taken there.
     */
    private importTranscript(client: ClientLink, message: ImportTranscriptMessage): void {
        const {requestId, sessionId, uploadId} = message;
        const answer = (error?: string) => {
            if (client.closed) return;
            client.send(error ? {type: 'done', requestId, ok: false, error} : {type: 'done', requestId, ok: true});
        };
        if (!SESSION_ID.test(sessionId)) return answer(`not a session id: ${sessionId}`);
        const dir = this.resumeDir(message.dir);
        if (!dir) return answer(`not a folder a session can resume in: ${message.dir}`);
        const existing = this.find(sessionId);
        if (existing) return answer(`a transcript of session ${sessionId} is already on this host`);

        const taken = this.deps.uploads.take(uploadId);
        if ('error' in taken) return answer(taken.error);

        const target = `${this.deps.projectsDir}/${encodeProjectPath(dir)}/${sessionId}.jsonl`;
        try {
            // The Mac cannot know this machine's home, so a handed-off
            // transcript's `cwd` lines say `~/…`; here they become absolute, as
            // every transcript Claude writes itself has them.
            const text = this.deps.files.readText(taken.file);
            if (text !== null && text.includes('~')) {
                this.deps.files.writeText(taken.file, rewriteTranscriptCwd(text, '~', this.deps.home));
            }
            this.deps.files.moveNoClobber(taken.file, target, 0o600);
        } catch (err) {
            this.deps.files.remove(taken.file);
            this.deps.log.warn(`[transcripts] import of ${sessionId} failed: ${errorText(err)}`);
            return answer(`could not place the transcript: ${errorText(err)}`);
        }
        this.deps.log.info(`[transcripts] imported ${sessionId} into ${target}`);
        // A client waiting on this id hears of it without waiting for the poll.
        const watched = this.watched.get(sessionId);
        if (watched) this.check(watched);
        answer();
    }

    /**
     * `dir` as the folder Claude will run in: `~` expanded, made absolute
     * against the home folder, `.` and `..` and doubled slashes folded, and
     * symlinks resolved when it exists, since Claude names its project folder
     * after its real working directory. Null when nothing is left of it.
     */
    private resumeDir(dir: string): string | null {
        const expanded = expandHome(dir.trim(), this.deps.home);
        const absolute = expanded.startsWith('/') ? expanded : `${this.deps.home}/${expanded}`;
        const segments: string[] = [];
        for (const segment of absolute.split('/')) {
            if (segment === '' || segment === '.') continue;
            if (segment === '..') segments.pop();
            else segments.push(segment);
        }
        if (segments.length === 0) return null;
        const normal = '/' + segments.join('/');
        return this.deps.files.realpath(normal) ?? normal;
    }
}

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
