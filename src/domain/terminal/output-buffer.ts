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
  readonly #chunks: string[] = [];
  #size = 0;
  readonly #maxSize: number;
  /** Set while a resize redraw is in flight, to keep it out of the replay. */
  #suppressed = false;

  constructor(maxSize: number = DEFAULT_MAX_BUFFER_SIZE) {
    this.#maxSize = maxSize;
  }

  get size(): number {
    return this.#size;
  }

  get suppressed(): boolean {
    return this.#suppressed;
  }

  /**
   * Stop recording.
   *
   * A plain terminal redraws its prompt on every resize, and those redraws
   * accumulate into a replay of a dozen stacked prompts. Suppressing across the
   * resize is what keeps a reattach showing one.
   */
  suppress(): void {
    this.#suppressed = true;
  }

  resume(): void {
    this.#suppressed = false;
  }

  append(data: string): void {
    if (this.#suppressed) return;
    this.#chunks.push(data);
    this.#size += data.length;
    // Always leave one chunk, however large: an empty replay is worse than an
    // over-long one, and a single write can exceed the whole budget.
    while (this.#size > this.#maxSize && this.#chunks.length > 1) {
      this.#size -= (this.#chunks.shift() ?? '').length;
    }
  }

  /** What to replay, oldest first. */
  chunks(): readonly string[] {
    return this.#chunks;
  }

  clear(): void {
    this.#chunks.length = 0;
    this.#size = 0;
  }
}
