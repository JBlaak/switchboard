/**
 * The TranscriptTail port over the FileSystem port: a slice off the end of the
 * file, so a long transcript is never read whole.
 */
import type {FileSystem} from '../../application/ports/file-system';
import type {TranscriptTail} from '../../application/ports/transcript-tail';

export class FileTranscriptTail implements TranscriptTail {
    constructor(private readonly fs: FileSystem) {}

    public read(path: string, maxBytes: number): string | null {
        const stat = this.fs.stat(path);
        if (!stat) return null;
        const length = Math.min(stat.size, maxBytes);
        try {
            return this.fs.readSlice(path, {start: stat.size - length, length});
        } catch {
            return null;
        }
    }
}
