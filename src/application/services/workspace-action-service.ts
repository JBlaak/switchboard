/**
 * The workspace actions (#342): a session's working directory opened in the
 * IDE that matches the repo, in Finder, or in a shell.
 *
 * The folder is the session's working directory: the last worktree its main
 * transcript was written from, else the directory it started in, whichever is
 * still there, taken up to its worktree's root. Which IDE is the domain's
 * `detectEditor`, over a listing of that folder. A missing IDE falls back to
 * Sublime Text, then to a Finder window; Shell here opens iTerm, else
 * Terminal. Remote (ssh/VM) sessions are not on this Mac, so their actions
 * answer that they are not available.
 */
import {
    ANDROID_MANIFESTS,
    detectEditor,
    EDITOR_APPS,
    editorFallbacks,
    GRADLE_SCRIPTS,
    SHELL_APPS,
    type FolderListing,
} from '../../domain/workspace/editor';
import {
    NO_FOLDER,
    NO_SESSION,
    NOT_AVAILABLE_REMOTE,
    NOTHING_OPENED,
    type WorkspaceActionResult,
    type WorkspaceEditorInfo,
    type WorkspaceTarget,
} from '../../domain/workspace/model';
import {isRemoteProjectPath} from '../../domain/project/remote-target';
import type {FileSystem} from '../ports/file-system';
import type {GitWorkspace} from '../ports/git-workspace';
import type {Logger} from '../ports/logger';
import type {Awaitable} from '../ports/transcript-queries';
import type {TranscriptLocation} from '../ports/transcript-store';
import type {WorkspaceLauncher} from '../ports/workspace-launcher';

export interface WorkspaceActionDeps {
    /** Where a session lives, or null when no session goes by that id. */
    locate(sessionId: string): {folder: string | null; projectPath: string} | null;
    transcripts: {locations(folder: string, sessionId: string): Awaitable<TranscriptLocation[]>};
    /** Without it, a directory is used as it is rather than taken up to its worktree's root. */
    git?: Pick<GitWorkspace, 'worktreeRoot'>;
    fs: Pick<FileSystem, 'exists' | 'isDirectory' | 'readDir' | 'readText' | 'join'>;
    launcher: WorkspaceLauncher;
    log: Logger;
}

/** A folder resolved for an action, or why there is none. */
type Resolved = {ok: true; directory: string} | {ok: false; reason: string};

export class WorkspaceActionService {
    constructor(private readonly deps: WorkspaceActionDeps) {}

    /** The IDE the Editor action would open the folder in, for the tray's label. */
    public async editorFor(target: WorkspaceTarget): Promise<WorkspaceEditorInfo> {
        const resolved = await this.resolve(target);
        if (!resolved.ok) return {available: false, reason: resolved.reason};
        const editor = detectEditor(this.listing(resolved.directory));
        return {available: true, directory: resolved.directory, editor, app: EDITOR_APPS[editor]};
    }

    /** Open the folder in its IDE; a missing one falls back to Sublime Text, then Finder. */
    public async openInEditor(target: WorkspaceTarget): Promise<WorkspaceActionResult> {
        const resolved = await this.resolve(target);
        if (!resolved.ok) return resolved;
        const apps = editorFallbacks(detectEditor(this.listing(resolved.directory))).map((e) => EDITOR_APPS[e]);
        const opened = await this.openWithFirst(apps, resolved.directory);
        if (opened) return opened;
        return this.finder(resolved.directory);
    }

    /** Open the folder in a Finder window. */
    public async revealInFinder(target: WorkspaceTarget): Promise<WorkspaceActionResult> {
        const resolved = await this.resolve(target);
        if (!resolved.ok) return resolved;
        return this.finder(resolved.directory);
    }

    /** Open a shell in the folder: iTerm when installed, else Terminal. */
    public async shellHere(target: WorkspaceTarget): Promise<WorkspaceActionResult> {
        const resolved = await this.resolve(target);
        if (!resolved.ok) return resolved;
        return (await this.openWithFirst(SHELL_APPS, resolved.directory)) ?? {ok: false, reason: NOTHING_OPENED};
    }

    private async openWithFirst(apps: readonly string[], directory: string): Promise<WorkspaceActionResult | null> {
        for (const app of apps) {
            if (await this.deps.launcher.openWith(app, directory)) {
                this.deps.log.info('[workspace] opened', directory, 'in', app);
                return {ok: true, directory, openedWith: app};
            }
            this.deps.log.info('[workspace]', app, 'would not open', directory);
        }
        return null;
    }

    private async finder(directory: string): Promise<WorkspaceActionResult> {
        if (await this.deps.launcher.showInFinder(directory)) return {ok: true, directory, openedWith: 'Finder'};
        return {ok: false, reason: NOTHING_OPENED};
    }

    private async resolve(target: WorkspaceTarget): Promise<Resolved> {
        if ('sessionId' in target) return this.resolveSession(String(target.sessionId));
        const directory = String(target.directory ?? '');
        if (isRemote(directory)) return {ok: false, reason: NOT_AVAILABLE_REMOTE};
        if (!this.isLocalDirectory(directory)) return {ok: false, reason: NO_FOLDER};
        return {ok: true, directory: await this.worktreeRoot(directory)};
    }

    private async resolveSession(sessionId: string): Promise<Resolved> {
        const located = this.deps.locate(sessionId);
        if (!located) return {ok: false, reason: NO_SESSION};
        if (isRemote(located.projectPath) || isRemote(located.folder ?? '')) {
            return {ok: false, reason: NOT_AVAILABLE_REMOTE};
        }
        const candidates = [await this.lastCwd(located.folder, sessionId), located.projectPath];
        const directory = candidates.find((path): path is string => !!path && this.isLocalDirectory(path));
        if (!directory) return {ok: false, reason: NO_FOLDER};
        return {ok: true, directory: await this.worktreeRoot(directory)};
    }

    /** The last directory the session's main conversation was written from. */
    private async lastCwd(folder: string | null, sessionId: string): Promise<string | null> {
        if (!folder) return null;
        try {
            const own = (await this.deps.transcripts.locations(folder, sessionId)).filter((l) => !l.fromSubagent);
            return own.at(-1)?.cwd ?? null;
        } catch (err) {
            this.deps.log.warn('[workspace] could not read where', sessionId, 'worked:', err);
            return null;
        }
    }

    private async worktreeRoot(directory: string): Promise<string> {
        if (!this.deps.git) return directory;
        try {
            return (await this.deps.git.worktreeRoot(directory)) ?? directory;
        } catch {
            return directory;
        }
    }

    /** An absolute path to a directory on this Mac; never a file, which `open -a` would run. */
    private isLocalDirectory(path: string): boolean {
        return path.startsWith('/') && this.deps.fs.isDirectory(path);
    }

    /** What `detectEditor` needs to know about the folder. */
    private listing(directory: string): FolderListing {
        const {fs} = this.deps;
        let topLevel: string[] = [];
        try {
            topLevel = fs.readDir(directory).map((entry) => entry.name);
        } catch (err) {
            this.deps.log.warn('[workspace] could not list', directory, err);
        }
        const gradleFiles: Record<string, string> = {};
        for (const name of GRADLE_SCRIPTS) {
            const path = fs.join(directory, name);
            if (!fs.exists(path)) continue;
            try {
                gradleFiles[name] = fs.readText(path);
            } catch {
                // Unreadable: it names no plugin.
            }
        }
        const androidManifest = ANDROID_MANIFESTS.some((name) => fs.exists(fs.join(directory, name)));
        return {topLevel, androidManifest, gradleFiles};
    }
}

function isRemote(path: string): boolean {
    return isRemoteProjectPath(path) || path.startsWith('vm:');
}
