/**
 * Reading a working tree's files for the Mac's pages, behind the tools part's
 * WorkingFiles port (#276 stage 4, #296).
 *
 * Only a regular file, and never through a symlink anywhere on its path: each
 * segment from `/` down is `lstat`ed and a symlink at any of them refuses the
 * path. The Mac's own `workingFile` checks that a file resolves inside its
 * worktree; here the agent does not know the worktree (the Mac sends an
 * absolute path), so it refuses every symlink instead, which a page reading
 * a diff's files never needs to follow.
 *
 * The path is normalised first and a `..` or `.` segment refused outright:
 * the kernel resolves `a/link/..` through the link, so checking the
 * normalised `a` would check the wrong folder.
 *
 * The read opens with O_NOFOLLOW (a symlink swapped in for the file after
 * the check fails to open) and O_NONBLOCK (a FIFO swapped in can't hang the
 * agent), then checks the open file is still the regular file the `lstat`
 * saw, by device and inode, before reading a byte.
 */
import fs from 'node:fs';
import path from 'node:path';

import type {WorkingFiles} from '../../application/services/agent-host/tools';

export class NodeWorkingFiles implements WorkingFiles {
    public async read(file: string, maxBytes: number): Promise<Uint8Array | null> {
        const stat = await regularFile(file);
        if (!stat || stat.size > maxBytes) return null;
        let handle: fs.promises.FileHandle | null = null;
        try {
            handle = await fs.promises.open(
                file,
                fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
            );
            const opened = await handle.stat();
            if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) return null;
            if (opened.size > maxBytes) return null;
            // Read at most one byte past the limit, to notice a file that grew since the stat.
            const buffer = Buffer.alloc(Math.min(opened.size, maxBytes) + 1);
            let length = 0;
            while (length < buffer.length) {
                const {bytesRead} = await handle.read(buffer, length, buffer.length - length, length);
                if (bytesRead === 0) break;
                length += bytesRead;
            }
            return length > maxBytes ? null : buffer.subarray(0, length);
        } catch {
            return null;
        } finally {
            await handle?.close().catch(() => {});
        }
    }

    public async size(file: string): Promise<number | null> {
        return (await regularFile(file))?.size ?? null;
    }
}

/** The file's lstat when it is a regular file reached through no symlink; null otherwise. */
async function regularFile(file: string): Promise<fs.Stats | null> {
    if (!path.isAbsolute(file) || file.includes('\0')) return null;
    const segments = file.split('/').filter((segment) => segment.length > 0);
    if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) return null;
    let current = '/';
    try {
        for (let i = 0; i < segments.length; i++) {
            current = path.join(current, segments[i]);
            const stat = await fs.promises.lstat(current);
            if (stat.isSymbolicLink()) return null;
            const last = i === segments.length - 1;
            if (last) return stat.isFile() ? stat : null;
            if (!stat.isDirectory()) return null;
        }
    } catch {
        // Missing, or not ours to read.
    }
    return null;
}
