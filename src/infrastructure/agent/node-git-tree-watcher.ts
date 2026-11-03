/**
 * `fs.watch` on a working tree's git state, behind the tools part's
 * TreeWatcher port (#276 stage 4, #296).
 *
 * What `GitCliWorkspace.watch` watches on the Mac, so a VM worktree refreshes
 * on the same events a local one does (see `tools-watches.ts` for why the
 * working files themselves are not watched):
 *
 * - the worktree's own git dir, not recursively: HEAD and the index. For a
 *   linked worktree that is `.git/worktrees/<name>`, read from the `.git`
 *   file's `gitdir:` line.
 * - the common dir it shares with the main checkout, when that is another
 *   folder, not recursively: `packed-refs`, which a `git gc` or a fetch
 *   rewrites in place of loose refs.
 * - the common dir's `refs`, recursively: a commit, a branch, a fetch. Node
 *   22 does this on Linux with one inotify watch per folder under `refs`,
 *   which is a handful. Where recursive watching throws, `refs/heads` alone.
 *
 * `persistent: false`, so a watch never keeps the agent alive on its own.
 * Null when the git dir can't be found or watched (no `.git` on disk, or
 * inotify's limit hit, ENOSPC): the part polls instead. A watch that breaks
 * later (the worktree removed) reports it once through `onError` and closes.
 */
import fs from 'node:fs';
import path from 'node:path';

import type {TreeWatch, TreeWatcher} from '../../application/services/agent-host/tools-watches';

export class NodeGitTreeWatcher implements TreeWatcher {
    public watch(dir: string, onChange: () => void, onError: () => void): TreeWatch | null {
        const dirs = gitDirs(dir);
        if (!dirs) return null;
        const watchers: fs.FSWatcher[] = [];
        let closed = false;
        const close = () => {
            if (closed) return;
            closed = true;
            for (const watcher of watchers) watcher.close();
            watchers.length = 0;
        };
        const tryWatch = (target: string, recursive: boolean): boolean => {
            try {
                const watcher = fs.watch(target, {recursive, persistent: false}, () => {
                    if (!closed) onChange();
                });
                watcher.on('error', () => {
                    if (closed) return;
                    close();
                    onError();
                });
                watchers.push(watcher);
                return true;
            } catch {
                return false;
            }
        };

        // Without the git dir there is no HEAD or index to hear of: poll instead.
        if (!tryWatch(dirs.gitDir, false)) return null;
        if (dirs.commonDir !== dirs.gitDir) tryWatch(dirs.commonDir, false);
        const refs = path.join(dirs.commonDir, 'refs');
        if (!tryWatch(refs, true)) tryWatch(path.join(refs, 'heads'), false);
        return {close};
    }
}

/**
 * A worktree's own git dir and the common dir it shares with the main
 * checkout, read off disk as the Mac's `GitCliWorkspace` reads them: in a
 * linked worktree `.git` is a file saying `gitdir: <path>`, and that folder
 * holds a `commondir` file pointing back at the main `.git`.
 */
function gitDirs(worktree: string): {gitDir: string; commonDir: string} | null {
    const dotGit = path.join(worktree, '.git');
    try {
        if (fs.statSync(dotGit).isDirectory()) return {gitDir: dotGit, commonDir: dotGit};
        const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
        if (!pointer) return null;
        const gitDir = path.resolve(worktree, pointer[1].trim());
        let commonDir = gitDir;
        try {
            commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
        } catch {
            // No `commondir`: a separate git dir that is its own common dir.
        }
        return {gitDir, commonDir};
    } catch {
        return null;
    }
}
