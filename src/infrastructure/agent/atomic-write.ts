/**
 * Writing a file so a reader never sees half of it.
 *
 * The content goes to a temporary file beside the target, then is renamed over
 * it: a rename within one folder is atomic on Linux, so a session starting
 * while the config copy runs reads the old file or the new one, never a torn
 * one, and a crash mid-write leaves the old file in place.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function writeFileAtomic(target: string, content: string | Uint8Array, mode: number): void {
    fs.mkdirSync(path.dirname(target), {recursive: true});
    const tmp = path.join(
        path.dirname(target),
        `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`,
    );
    try {
        fs.writeFileSync(tmp, content, {mode});
        // writeFileSync's mode is filtered by the umask; the mode asked for is the one wanted.
        fs.chmodSync(tmp, mode);
        fs.renameSync(tmp, target);
    } catch (err) {
        fs.rmSync(tmp, {force: true});
        throw err;
    }
}
