/**
 * One agent session's recent terminal output, as numbered chunks (#284).
 *
 * The Mac can be gone for hours (asleep, closed, on a train) while a VM
 * session keeps printing, and when it comes back it asks for what it missed by
 * the last chunk number it showed. So output is kept as the chunks the PTY
 * produced, each with a sequence number that counts from 0 and never repeats,
 * bounded by bytes rather than by chunk count: a burst of tiny chunks and one
 * full-screen redraw cost very different amounts of memory.
 *
 * Chunks are kept whole. Cutting one in half could split an escape sequence or
 * a UTF-8 character, and a replay that starts in the middle of either draws
 * garbage; dropping whole chunks from the front only ever loses history.
 */

/** How much output each session keeps for a replay: about a long build log's worth. */
export const SCROLLBACK_MAX_BYTES = 2 * 1024 * 1024;

/** One kept chunk of output. */
export interface ScrollbackChunk {
    seq: number;
    data: string;
}

/** What a client that last saw `since` is sent. */
export interface Replay {
    /** The replay does not continue from `since`: the client clears its terminal first. */
    reset: boolean;
    chunks: ScrollbackChunk[];
}

export class Scrollback {
    private chunks: (ScrollbackChunk & {bytes: number})[] = [];
    private bytes = 0;
    private nextSeq = 0;

    constructor(private readonly maxBytes: number = SCROLLBACK_MAX_BYTES) {}

    /** The last chunk's sequence number; -1 before any output. */
    public get lastSeq(): number {
        return this.nextSeq - 1;
    }

    /**
     * Keep a chunk and number it.
     *
     * The newest chunk is always kept, even when it alone is over the bound,
     * so a replay never comes back empty for a session that printed something.
     */
    public append(data: string): ScrollbackChunk {
        const chunk = {seq: this.nextSeq++, data, bytes: Buffer.byteLength(data, 'utf8')};
        this.chunks.push(chunk);
        this.bytes += chunk.bytes;
        while (this.bytes > this.maxBytes && this.chunks.length > 1) {
            this.bytes -= this.chunks.shift()!.bytes;
        }
        return {seq: chunk.seq, data};
    }

    /**
     * Everything after `since` that is still kept.
     *
     * A reset when `since + 1` was evicted, so the client knows there is a gap.
     * Also a reset when `since` is past the last chunk: the client is counting
     * in a stream this one is not (the session was started again since), and
     * replaying from where it thinks it is would show it nothing at all.
     */
    public since(since: number): Replay {
        const oldest = this.chunks[0]?.seq ?? this.nextSeq;
        const reset = since + 1 < oldest || since > this.lastSeq;
        const from = reset ? oldest : since + 1;
        return {reset, chunks: this.chunks.filter((c) => c.seq >= from).map(({seq, data}) => ({seq, data}))};
    }
}
