/**
 * The end of a scheduled run's output, kept within a cap.
 *
 * The end is what matters: the CLI's result JSON is the last thing on stdout,
 * and a failing run's reason the last line on stderr. A run that prints more
 * than the cap loses its start, never that.
 */

/** The most of a run's stdout kept: room for a long report. */
export const STDOUT_TAIL_CHARS = 1024 * 1024;
/** The most of a run's stderr kept. */
export const STDERR_TAIL_CHARS = 8 * 1024;

export interface OutputTail {
    add(chunk: Buffer): void;
    text(): string;
}

export function outputTail(cap: number): OutputTail {
    let text = '';
    return {
        add(chunk) {
            text += chunk.toString('utf8');
            // Trimmed only once well past the cap, so a chatty run is not re-sliced on every chunk.
            if (text.length > cap * 2) text = text.slice(-cap);
        },
        text: () => (text.length > cap ? text.slice(-cap) : text),
    };
}
