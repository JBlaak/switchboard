/**
 * The end of a session's transcript, read where its hook server runs.
 *
 * When a turn ends the Stop hook names the session's `.jsonl` transcript; the
 * hook server reads its last stretch to find every text block the turn wrote
 * (`domain/grill/hook-input.ts`). Only the tail: a transcript can be tens of
 * megabytes, and the turn that just ended is at its end.
 */
export interface TranscriptTail {
    /**
     * Up to the last `maxBytes` of the file at `path`, as UTF-8 (the first line
     * may be cut off), or null when it does not exist or cannot be read.
     */
    read(path: string, maxBytes: number): string | null;
}
