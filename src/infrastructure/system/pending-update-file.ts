/**
 * The pending update as a small JSON file, behind the PendingUpdateStore port.
 *
 * Written just before the app quits to swap itself, and read (and removed) by
 * the next launch, which compares the version it meant to become with the one
 * it is. A missing or unreadable file is no pending update.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type {PendingUpdate} from '../../domain/update/progress';
import type {PendingUpdateStore} from '../../application/ports/updates';

export class PendingUpdateFile implements PendingUpdateStore {
    constructor(private readonly file: string) {}

    public async write(pending: PendingUpdate): Promise<void> {
        await fs.mkdir(path.dirname(this.file), {recursive: true});
        await fs.writeFile(this.file, JSON.stringify(pending));
    }

    public async take(): Promise<PendingUpdate | null> {
        let text: string;
        try {
            text = await fs.readFile(this.file, 'utf8');
        } catch {
            return null;
        }
        await fs.rm(this.file, {force: true});
        try {
            const {from, to} = JSON.parse(text) as Record<string, unknown>;
            return typeof from === 'string' && typeof to === 'string' ? {from, to} : null;
        } catch {
            return null;
        }
    }
}
