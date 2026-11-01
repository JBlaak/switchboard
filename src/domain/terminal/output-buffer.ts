/**
 * The scrollback a session keeps for the next renderer that attaches to it.
 *
 * A session outlives the window showing it: the renderer can reload, the user
 * can switch away, a grid card can be torn down and rebuilt. Replaying this
 * buffer is what puts the screen back rather than leaving a black rectangle
 * until the CLI happens to repaint.
 *
 * Bounded by bytes, not chunks — a TUI repainting at 60fps produces thousands of
 * tiny writes, and a chunk count would either keep megabytes or throw away a
 * whole screen.
 */

/** How much output is held per session. */
export const DEFAULT_MAX_BUFFER_SIZE = 256 * 1024;

export class OutputBuffer {
    private readonly stored: string[] = [];
    private storedSize = 0;
    private readonly maxSize: number;
    /** Set while a resize redraw is in flight, to keep it out of the replay. */
    private isSuppressed = false;

    constructor(maxSize: number = DEFAULT_MAX_BUFFER_SIZE) {
        this.maxSize = maxSize;
    }

    public get size(): number {
        return this.storedSize;
    }

    public get suppressed(): boolean {
        return this.isSuppressed;
    }

    /**
     * Stop recording.
     *
     * A plain terminal redraws its prompt on every resize, and those redraws
     * accumulate into a replay of a dozen stacked prompts. Suppressing across the
     * resize is what keeps a reattach showing one.
     */
    public suppress(): void {
        this.isSuppressed = true;
    }

    public resume(): void {
        this.isSuppressed = false;
    }

    public append(data: string): void {
        if (this.isSuppressed) return;
        this.stored.push(data);
        this.storedSize += data.length;
        // Always leave one chunk, however large: an empty replay is worse than an
        // over-long one, and a single write can exceed the whole budget.
        while (this.storedSize > this.maxSize && this.stored.length > 1) {
            this.storedSize -= (this.stored.shift() ?? '').length;
        }
    }

    /** What to replay, oldest first. */
    public chunks(): readonly string[] {
        return this.stored;
    }

    public clear(): void {
        this.stored.length = 0;
        this.storedSize = 0;
    }
}
