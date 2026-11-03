/**
 * The agent's chunked uploads, for a hand-off's git bundle and patch (#276 stage 2).
 *
 * A bundle can be far bigger than one frame (MAX_FRAME_BYTES), so the Mac
 * sends it as `upload-begin`, any number of `upload-chunk`s and `upload-end`,
 * and a later `handoff` names it by id. Each upload is one file in a private
 * (0700) temp folder the agent made itself, named by the agent rather than by
 * the Mac's id, so an id can never pick a path.
 *
 * Only `upload-end` carries a request id, so it is the one place a problem can
 * be answered. Whatever goes wrong before it (an unknown id, too many bytes, a
 * chunk after the end) marks the upload failed, and `upload-end`, or the
 * `handoff` naming it, reports why.
 *
 * An upload nobody uses is thrown away after UPLOAD_TTL_MS without activity,
 * and a client that goes away loses the uploads it had not finished: nobody
 * else can finish them.
 */
import {UPLOAD_TTL_MS} from '../../../domain/agent/protocol';
import type {UploadBeginMessage, UploadChunkMessage, UploadEndMessage} from '../../../domain/agent/protocol';
import type {ClientLink} from '../../ports/agent-link';
import type {TimerHandle, Timers} from '../../ports/clock';
import type {IdGenerator} from '../../ports/ids';
import type {Logger} from '../../ports/logger';
import type {CopiesFiles} from './copies';

/**
 * The largest single upload the agent accepts: 512 MiB.
 *
 * A bundle holds only the commits origin lacks and a patch only the
 * uncommitted changes, so a real one is kilobytes to a few megabytes. The cap
 * is there so a runaway or hostile `size` cannot fill the VM's temp folder; a
 * hand-off that really carries more should be pushed instead.
 */
export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

/** One upload, from `upload-begin` until it is used, expires or fails. */
interface Upload {
    client: ClientLink;
    /** The file it is written to; null once it failed and the file was dropped. */
    file: string | null;
    size: number;
    received: number;
    finished: boolean;
    /** Why it can no longer be used, kept so `upload-end` or `handoff` can say so. */
    error: string | null;
    timer: TimerHandle;
}

export interface UploadsDeps {
    files: CopiesFiles;
    timers: Timers;
    ids: IdGenerator;
    log: Logger;
    /** Overrides MAX_UPLOAD_BYTES, for tests. */
    maxBytes?: number;
}

export class Uploads {
    private readonly uploads = new Map<string, Upload>();
    /** The private folder, made on the first upload and kept for the agent's life. */
    private folder: string | null = null;

    constructor(private readonly deps: UploadsDeps) {}

    public begin(client: ClientLink, message: UploadBeginMessage): void {
        const {uploadId, size} = message;
        if (this.uploads.has(uploadId)) {
            // Two uploads under one id would interleave into one file, and no
            // chunk says which one it belongs to, so neither can be trusted.
            this.deps.log.warn(`[copies] upload ${uploadId} began twice`);
            this.fail(uploadId, `upload ${uploadId} began twice`);
            return;
        }
        const maxBytes = this.deps.maxBytes ?? MAX_UPLOAD_BYTES;
        const upload: Upload = {
            client,
            file: null,
            size,
            received: 0,
            finished: false,
            error: null,
            timer: null,
        };
        this.uploads.set(uploadId, upload);
        this.touch(uploadId, upload);
        if (size < 0 || size > maxBytes) {
            upload.error = `upload ${uploadId} is ${size} bytes; the most the agent takes is ${maxBytes}`;
            return;
        }
        try {
            upload.file = `${this.privateFolder()}/${this.deps.ids.newId()}.upload`;
            // An empty file now, so an upload of zero bytes still has one.
            this.deps.files.append(upload.file, new Uint8Array());
        } catch (err) {
            upload.file = null;
            upload.error = `could not store upload ${uploadId}: ${errorText(err)}`;
        }
    }

    public chunk(message: UploadChunkMessage): void {
        const upload = this.uploads.get(message.uploadId);
        if (!upload) {
            this.deps.log.warn(`[copies] chunk for unknown upload ${message.uploadId}`);
            return;
        }
        if (upload.error) return;
        if (upload.finished) {
            this.fail(message.uploadId, `upload ${message.uploadId} got data after it ended`);
            return;
        }
        const bytes = Buffer.from(message.dataBase64, 'base64');
        if (upload.received + bytes.length > upload.size) {
            this.fail(
                message.uploadId,
                `upload ${message.uploadId} is larger than the ${upload.size} bytes it announced`,
            );
            return;
        }
        try {
            this.deps.files.append(upload.file as string, bytes);
            upload.received += bytes.length;
            this.touch(message.uploadId, upload);
        } catch (err) {
            this.fail(message.uploadId, `could not store upload ${message.uploadId}: ${errorText(err)}`);
        }
    }

    /** Check the size and SHA-256; answers `done`. */
    public async end(client: ClientLink, message: UploadEndMessage): Promise<void> {
        const {requestId, uploadId} = message;
        const answer = (error?: string) => {
            if (client.closed) return;
            client.send(error ? {type: 'done', requestId, ok: false, error} : {type: 'done', requestId, ok: true});
        };
        const upload = this.uploads.get(uploadId);
        if (!upload) return answer(`unknown upload ${uploadId} (it may have expired)`);
        if (upload.error) return answer(upload.error);
        if (upload.finished) return answer(`upload ${uploadId} already ended`);
        if (upload.received !== upload.size) {
            return answer(this.fail(uploadId, `upload ${uploadId} has ${upload.received} of ${upload.size} bytes`));
        }
        upload.finished = true;
        let actual: string;
        try {
            actual = await this.deps.files.sha256(upload.file as string);
        } catch (err) {
            return answer(this.fail(uploadId, `could not read upload ${uploadId}: ${errorText(err)}`));
        }
        // A chunk after the end, or an expiry, may have landed while hashing.
        if (this.uploads.get(uploadId) !== upload || upload.error) {
            return answer(upload.error ?? `upload ${uploadId} expired`);
        }
        if (actual.toLowerCase() !== message.sha256.toLowerCase()) {
            return answer(this.fail(uploadId, `upload ${uploadId} does not match its SHA-256`));
        }
        this.touch(uploadId, upload);
        answer();
    }

    /**
     * The file of a finished, checked upload, for a hand-off; an error naming
     * the problem otherwise.
     */
    public fileOf(uploadId: string): {file: string; size: number} | {error: string} {
        const upload = this.uploads.get(uploadId);
        if (!upload) return {error: `unknown upload ${uploadId} (it may have expired)`};
        if (upload.error) return {error: upload.error};
        if (!upload.finished || upload.file === null) return {error: `upload ${uploadId} has not ended`};
        // A hand-off is using it: it must not expire under the hand-off.
        this.deps.timers.clearTimeout(upload.timer);
        upload.timer = null;
        return {file: upload.file, size: upload.size};
    }

    /**
     * Hand over a finished, checked upload's file for good, for a transcript
     * import (#276 stage 3): the uploads forget it, so it never expires or is
     * deleted under the taker, who now owns the file and moves or deletes it.
     * An error naming the problem otherwise, and the upload is left as it was.
     */
    public take(uploadId: string): {file: string; size: number} | {error: string} {
        const found = this.fileOf(uploadId);
        if ('error' in found) return found;
        this.uploads.delete(uploadId);
        return found;
    }

    /** Forget an upload and delete its file. */
    public drop(uploadId: string): void {
        const upload = this.uploads.get(uploadId);
        if (!upload) return;
        this.uploads.delete(uploadId);
        this.deps.timers.clearTimeout(upload.timer);
        this.removeFile(upload);
    }

    /** A client went away: its unfinished uploads can never be finished. */
    public clientGone(client: ClientLink): void {
        for (const [id, upload] of [...this.uploads]) {
            if (upload.client === client && !upload.finished) this.drop(id);
        }
    }

    /** How many uploads the agent holds now, for tests and logs. */
    public get count(): number {
        return this.uploads.size;
    }

    /** Mark an upload failed, drop its bytes, and give back the reason. */
    private fail(uploadId: string, error: string): string {
        const upload = this.uploads.get(uploadId);
        if (upload) {
            upload.error ??= error;
            this.removeFile(upload);
        }
        this.deps.log.warn(`[copies] ${error}`);
        return upload?.error ?? error;
    }

    /** (Re)start the expiry: an upload counts as used while bytes keep coming. */
    private touch(uploadId: string, upload: Upload): void {
        this.deps.timers.clearTimeout(upload.timer);
        upload.timer = this.deps.timers.setTimeout(() => {
            if (this.uploads.get(uploadId) !== upload) return;
            this.deps.log.info(`[copies] upload ${uploadId} expired unused`);
            this.drop(uploadId);
        }, UPLOAD_TTL_MS);
    }

    private removeFile(upload: Upload): void {
        if (upload.file === null) return;
        try {
            this.deps.files.removeTree(upload.file);
        } catch (err) {
            this.deps.log.warn(`[copies] could not delete ${upload.file}: ${errorText(err)}`);
        }
        upload.file = null;
    }

    private privateFolder(): string {
        this.folder ??= this.deps.files.makePrivateTempDir();
        return this.folder;
    }
}

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
