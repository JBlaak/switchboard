/**
 * Placing files dropped on a VM session's terminal, behind the copies part's
 * DropFiles port (#276 stage 5).
 *
 * A dropped file can be anything the user had on their Mac (a screenshot, a
 * log, a contract), so it is kept as privately as an upload: the file 0600,
 * every folder made on the way to it 0700, `~/.switchboard/drops` included.
 *
 * `place` never replaces a file. A hard link fails when the target exists,
 * and the copy fallback, for an upload on another filesystem as a tmpfs
 * `/tmp` is, opens the target with COPYFILE_EXCL.
 */
import fs from 'node:fs';
import path from 'node:path';

import type {DropFiles, DropFolder} from '../../application/services/agent-host/copies';

export class NodeDropFiles implements DropFiles {
    public listFolders(dir: string): DropFolder[] {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, {withFileTypes: true});
        } catch {
            return [];
        }
        const folders: DropFolder[] = [];
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            try {
                folders.push({name: entry.name, mtimeMs: fs.statSync(path.join(dir, entry.name)).mtimeMs});
            } catch {
                // Gone between the listing and the stat: nothing to clean.
            }
        }
        return folders;
    }

    public place(from: string, to: string, mode: number): void {
        // `recursive` applies its mode to every folder it makes, and the umask
        // can only take bits away from 0700.
        fs.mkdirSync(path.dirname(to), {recursive: true, mode: 0o700});
        try {
            fs.linkSync(from, to);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
            fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
        }
        fs.chmodSync(to, mode);
        fs.rmSync(from, {force: true});
    }

    public removeTree(target: string): void {
        try {
            fs.rmSync(target, {recursive: true, force: true});
        } catch {
            // Best effort: a drop left behind is removed on a later placing.
        }
    }

    public remove(file: string): void {
        try {
            fs.rmSync(file, {force: true});
        } catch {
            // Best effort: a leftover in the private upload folder harms nobody.
        }
    }
}
