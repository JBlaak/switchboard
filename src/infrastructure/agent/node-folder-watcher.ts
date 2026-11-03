/**
 * `fs.watch` on one folder, behind the transcripts part's FolderWatcher port
 * (#276 stage 3).
 *
 * Not recursive, and one watch per folder: on Linux that is one inotify watch,
 * and the part watches only folders that hold transcripts a Mac asked about
 * (see `transcripts.ts` for why that stays far under the watch limit).
 *
 * `persistent: false`, so a watch never keeps the agent's process alive on
 * its own. A folder that can't be watched (missing, or the limit hit, ENOSPC)
 * answers null and the part polls it; a watch that breaks later reports it
 * once through `onError` and is closed.
 */
import fs from 'node:fs';

import type {FolderWatch, FolderWatcher} from '../../application/services/agent-host/transcripts';

export class NodeFolderWatcher implements FolderWatcher {
    public watch(folder: string, onChange: () => void, onError: () => void): FolderWatch | null {
        let watcher: fs.FSWatcher;
        try {
            watcher = fs.watch(folder, {persistent: false}, () => onChange());
        } catch {
            return null;
        }
        let closed = false;
        watcher.on('error', () => {
            if (closed) return;
            closed = true;
            watcher.close();
            onError();
        });
        return {
            close() {
                if (closed) return;
                closed = true;
                watcher.close();
            },
        };
    }
}
