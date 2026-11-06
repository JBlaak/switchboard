/**
 * Walking a transcript's content blocks: the text, tool calls and tool
 * results of each conversation entry, whatever shape its message took.
 *
 * A support for the reads that look past the words into what the session
 * did (the artifacts it published, the pages it showed). Each block is handed
 * over with its entry's role and timestamp, in transcript order.
 */
import {parseTranscriptLine} from '../transcript';

/** One content block of a conversation entry. Every field is best-effort. */
export interface TranscriptBlock {
    role: 'user' | 'assistant';
    /** The entry's `timestamp`, as written; '' without one. */
    timestamp: string;
    type: string;
    text?: unknown;
    id?: unknown;
    name?: unknown;
    input?: unknown;
    tool_use_id?: unknown;
    content?: unknown;
    is_error?: unknown;
}

/** Every content block of every user and assistant entry in these lines, in order. */
export function* transcriptBlocks(lines: readonly string[]): Generator<TranscriptBlock> {
    for (const line of lines) {
        const entry = parseTranscriptLine(line);
        if (!entry) continue;
        const role = entry.type === 'message' ? entry.role : entry.type;
        if (role !== 'user' && role !== 'assistant') continue;
        const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : '';
        const message = entry.message;
        const content = typeof message === 'string' ? message : (message as {content?: unknown} | undefined)?.content;
        if (typeof content === 'string') {
            yield {role, timestamp, type: 'text', text: content};
            continue;
        }
        if (!Array.isArray(content)) continue;
        for (const block of content) {
            if (block && typeof block === 'object' && typeof (block as {type?: unknown}).type === 'string') {
                yield {...(block as Omit<TranscriptBlock, 'role' | 'timestamp'>), role, timestamp};
            }
        }
    }
}

/** A tool result's text, whether it came as a string or as text blocks. */
export function toolResultText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .map((part) =>
            part && typeof part === 'object' && typeof (part as {text?: unknown}).text === 'string'
                ? (part as {text: string}).text
                : '',
        )
        .filter(Boolean)
        .join('\n');
}
