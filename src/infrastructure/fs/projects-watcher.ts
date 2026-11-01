/**
 * Watching `~/.claude/projects` for the CLI's writes.
 *
 * This is how Switchboard stays live without polling: the CLI appends to a
 * transcript, the watcher notices, and the folder is re-indexed and the sidebar
 * refreshed. A CLI turn produces a burst of writes, so changes are debounced
 * and coalesced per folder — the interesting unit is "this project changed",
 * not "this file changed".
 */
import type {FileSystem, Watcher} from '../../application/ports/file-system';
import type {Logger} from '../../application/ports/logger';
import type {Timers} from '../../application/ports/clock';

/** How long to wait for a burst of writes to settle. */
const DEBOUNCE_MS = 500;

export interface ProjectsWatcherDeps {
    fs: FileSystem;
    timers: Timers;
    log: Logger;
    projectsDir: string;
    /** Called with the folders that changed, once the burst has settled. */
    onFoldersChanged(folders: readonly string[]): void;
}

export class ProjectsWatcher {
    private watcher: Watcher | null = null;
    private pending = new Set<string>();
    private debounce: unknown = null;

    constructor(private readonly deps: ProjectsWatcherDeps) {}

    public start(): void {
        const {fs, projectsDir, log} = this.deps;
        if (this.watcher || !fs.exists(projectsDir)) return;

        try {
            this.watcher = fs.watch(projectsDir, {recursive: true}, (_event, relativePath) => {
                if (relativePath) this.note(relativePath);
            });
        } catch (err) {
            log.error('[watcher] could not watch the projects directory:', (err as Error).message);
        }
    }

    public stop(): void {
        this.watcher?.close();
        this.watcher = null;
        this.deps.timers.clearTimeout(this.debounce);
        this.debounce = null;
        this.pending.clear();
    }

    /**
     * Decide whether a path is worth reacting to.
     *
     * Only two things are: a transcript being written, and a folder appearing or
     * disappearing. Everything else in there — index files, lock files, the CLI's
     * own scratch — would just cost a re-index.
     */
    private note(relativePath: string): void {
        const [folder, ...inside] = relativePath.split(this.deps.fs.separator);
        // Each top-level folder is one project's transcripts; a .git there is
        // someone keeping the directory under version control, not a project.
        if (folder === '' || folder === '.git') return;

        const isFolderItself = inside.length === 0;
        const isTranscript = (inside.at(-1) ?? folder).endsWith('.jsonl');
        if (!isFolderItself && !isTranscript) return;

        this.pending.add(folder);

        const {timers} = this.deps;
        timers.clearTimeout(this.debounce);
        this.debounce = timers.setTimeout(() => this.flush(), DEBOUNCE_MS);
    }

    private flush(): void {
        this.debounce = null;
        const folders = [...this.pending];
        this.pending.clear();
        if (folders.length) this.deps.onFoldersChanged(folders);
    }
}
