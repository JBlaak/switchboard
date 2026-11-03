/**
 * The transcripts part's file work on the VM's `~/.claude/projects`, behind
 * the TranscriptFiles port (#276 stage 3).
 *
 * Reads are plain and synchronous, like the Mac's own transcript store: a
 * transcript is read whole only when the Mac asked for it, and a tail reads a
 * slice, never the file.
 *
 * `moveNoClobber` places an imported transcript. It never replaces a file:
 * a hard link fails when the target exists, and the copy fallback (for an
 * upload on another filesystem, as a tmpfs `/tmp` is) opens the target with
 * COPYFILE_EXCL. Either way the conversation already on the VM is safe even
 * if two imports of one id race.
 */
import fs from 'node:fs';
import path from 'node:path';

import type {TranscriptFiles, TranscriptFileStat} from '../../application/services/agent-host/transcripts';

export class NodeTranscriptFiles implements TranscriptFiles {
    public listFolders(dir: string): string[] {
        try {
            return fs
                .readdirSync(dir, {withFileTypes: true})
                .filter((entry) => entry.isDirectory())
                .map((entry) => entry.name);
        } catch {
            return [];
        }
    }

    public stat(file: string): TranscriptFileStat | null {
        try {
            const stat = fs.statSync(file);
            if (!stat.isFile()) return null;
            return {
                mtimeMs: stat.mtimeMs,
                size: stat.size,
                modifiedIso: stat.mtime.toISOString(),
                createdIso: stat.birthtime.toISOString(),
            };
        } catch {
            return null;
        }
    }

    public readText(file: string): string | null {
        try {
            return fs.readFileSync(file, 'utf8');
        } catch {
            return null;
        }
    }

    public writeText(file: string, text: string): void {
        fs.writeFileSync(file, text, 'utf8');
    }

    public readSlice(file: string, start: number, length: number): Uint8Array | null {
        let fd: number | null = null;
        try {
            fd = fs.openSync(file, 'r');
            const buffer = Buffer.alloc(length);
            const read = fs.readSync(fd, buffer, 0, length, start);
            return buffer.subarray(0, read);
        } catch {
            return null;
        } finally {
            if (fd !== null) fs.closeSync(fd);
        }
    }

    public isDirectory(target: string): boolean {
        try {
            return fs.statSync(target).isDirectory();
        } catch {
            return false;
        }
    }

    public realpath(target: string): string | null {
        try {
            return fs.realpathSync(target);
        } catch {
            return null;
        }
    }

    public moveNoClobber(from: string, to: string, mode: number): void {
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

    public remove(file: string): void {
        try {
            fs.rmSync(file, {force: true});
        } catch {
            // Best effort: a leftover in the private upload folder harms nobody.
        }
    }
}
