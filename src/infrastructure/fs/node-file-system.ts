/**
 * Node's fs and path behind the FileSystem port.
 *
 * A thin adapter by design: the only judgement in it is that `stat` answers
 * null instead of throwing (a file that vanished between a listing and a stat
 * is normal, not exceptional) and that path comparison is done on resolved
 * paths.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
    DirEntry,
    FileStat,
    FileSystem,
    WatchListener,
    WatchOptions,
    Watcher,
} from '../../application/ports/file-system';

export class NodeFileSystem implements FileSystem {
    public readonly separator = path.sep;
    public readonly homeDir = os.homedir();

    public exists(target: string): boolean {
        return fs.existsSync(target);
    }

    public isDirectory(target: string): boolean {
        try {
            return fs.statSync(target).isDirectory();
        } catch {
            return false;
        }
    }

    public readText(target: string): string {
        return fs.readFileSync(target, 'utf8');
    }

    public writeText(target: string, content: string, options?: {mode?: number}): void {
        fs.writeFileSync(target, content, {encoding: 'utf8', ...options});
    }

    public readSlice(target: string, range: {start: number; length: number}): string {
        if (range.length <= 0) return '';
        const buffer = Buffer.alloc(range.length);
        const fd = fs.openSync(target, 'r');
        try {
            const read = fs.readSync(fd, buffer, 0, range.length, range.start);
            return buffer.toString('utf8', 0, read);
        } finally {
            fs.closeSync(fd);
        }
    }

    public readDir(target: string): DirEntry[] {
        return fs.readdirSync(target, {withFileTypes: true}).map((entry) => ({
            name: entry.name,
            isFile: entry.isFile(),
            isDirectory: entry.isDirectory(),
        }));
    }

    public stat(target: string): FileStat | null {
        try {
            const stat = fs.statSync(target);
            return {
                modifiedIso: stat.mtime.toISOString(),
                createdIso: stat.birthtime.toISOString(),
                mtimeMs: stat.mtimeMs,
                size: stat.size,
            };
        } catch {
            return null;
        }
    }

    public makeDir(target: string): void {
        fs.mkdirSync(target, {recursive: true});
    }

    public remove(target: string): void {
        fs.rmSync(target, {recursive: true, force: true});
    }

    public rename(from: string, to: string): void {
        fs.renameSync(from, to);
    }

    public watch(target: string, options: WatchOptions, listener: WatchListener): Watcher {
        const watcher = fs.watch(target, {recursive: options.recursive}, (eventType, filename) => {
            listener(eventType, filename === null ? null : String(filename));
        });
        // A watcher that throws unhandled takes the process with it; a lost watch
        // is survivable, because the reconcile pass catches up on the next render.
        watcher.on('error', () => {});
        return {close: () => watcher.close()};
    }

    public join(...parts: string[]): string {
        return path.join(...parts);
    }

    public basename(target: string, ext?: string): string {
        return path.basename(target, ext);
    }

    public dirname(target: string): string {
        return path.dirname(target);
    }

    public isInside(parent: string, child: string): boolean {
        const from = path.resolve(parent);
        const to = path.resolve(child);
        if (to === from) return true;
        return to.startsWith(from.endsWith(path.sep) ? from : from + path.sep);
    }
}
