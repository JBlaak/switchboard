/**
 * The project copies' file work on the VM, behind the CopiesFiles port.
 *
 * Uploads go to a folder made with mkdtemp under the system temp folder and
 * chmod 0700, each file 0600: a bundle and a patch carry the user's
 * unpublished code, and nobody else on the VM should read them while they
 * wait for their hand-off.
 *
 * `writeInside` is the second lock on writing a ticked file into a copy:
 * the part already checked the path with `isSafeRepoPath`, and this resolves
 * the folder the file lands in, symlinks and all, and refuses it unless it
 * stays inside the copy. A repository can hold a symlink, and `config -> /etc`
 * must not turn `config/x` into a write outside it.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {CopiesFiles} from '../../application/services/agent-host/copies';
import {writeFileAtomic} from './atomic-write';

export class NodeCopiesFiles implements CopiesFiles {
    constructor(private readonly tempRoot: string = os.tmpdir()) {}

    public makePrivateTempDir(): string {
        const dir = fs.mkdtempSync(path.join(this.tempRoot, 'switchboard-uploads-'));
        fs.chmodSync(dir, 0o700);
        return dir;
    }

    public append(file: string, bytes: Uint8Array): void {
        fs.appendFileSync(file, bytes, {mode: 0o600});
    }

    public sha256(file: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const hash = crypto.createHash('sha256');
            fs.createReadStream(file)
                .on('data', (chunk) => hash.update(chunk))
                .on('error', reject)
                .on('end', () => resolve(hash.digest('hex')));
        });
    }

    public writeFileAtomic(file: string, bytes: Uint8Array, mode: number): void {
        writeFileAtomic(file, bytes, mode);
    }

    public writeInside(root: string, relative: string, bytes: Uint8Array, mode: number): void {
        const realRoot = fs.realpathSync(root);
        const target = path.resolve(realRoot, relative);
        const inside = (p: string) => p === realRoot || p.startsWith(realRoot + path.sep);
        if (!inside(path.dirname(target))) throw new Error(`outside the copy: ${relative}`);
        // The nearest folder that exists already is checked before any is made,
        // so a symlinked folder can't have mkdir create anything outside.
        let existing = path.dirname(target);
        while (!fs.existsSync(existing)) existing = path.dirname(existing);
        if (!inside(fs.realpathSync(existing))) throw new Error(`outside the copy: ${relative}`);
        fs.mkdirSync(path.dirname(target), {recursive: true});
        const realFolder = fs.realpathSync(path.dirname(target));
        if (!inside(realFolder)) throw new Error(`outside the copy: ${relative}`);
        // Into the resolved folder, so the rename can't follow a symlink out of it.
        writeFileAtomic(path.join(realFolder, path.basename(target)), bytes, mode);
    }

    public removeTree(target: string): void {
        fs.rmSync(target, {recursive: true, force: true});
    }

    public exists(target: string): boolean {
        return fs.existsSync(target);
    }

    public readText(file: string): string | null {
        try {
            return fs.readFileSync(file, 'utf8');
        } catch {
            return null;
        }
    }

    public copyFile(from: string, to: string): void {
        fs.copyFileSync(from, to);
    }

    public realpath(target: string): string | null {
        try {
            return fs.realpathSync(target);
        } catch {
            return null;
        }
    }
}
