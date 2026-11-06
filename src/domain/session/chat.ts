/**
 * A transcript as a conversation: the messages the phone's chat view shows
 * instead of the terminal.
 *
 * Only what reads as a chat is kept: the user's prompts, Claude's text
 * replies, and each tool call folded to one short line ("Ran: git status").
 * Tool results, thinking, hook and command bookkeeping, subagent (sidechain)
 * turns and system reminders are left out; the terminal still has them.
 */
import {parseTranscriptLine} from './transcript';

/** One message of the chat view. */
export interface ChatMessage {
    /** Stable across reads: the transcript entry's uuid and the block's place in it. */
    id: string;
    /** user: a prompt; assistant: Claude's text; tool: one tool call, as one line. */
    role: 'user' | 'assistant' | 'tool';
    text: string;
}

/** The most of one message that is sent; a longer one ends in an ellipsis. */
export const MAX_CHAT_TEXT = 20_000;
/** The most of a tool line, which is one line by design. */
const MAX_TOOL_LINE = 120;

/** A content block as the CLI writes it; every field is best-effort. */
interface Block {
    type?: unknown;
    text?: unknown;
    name?: unknown;
    input?: unknown;
}

/** The fields of a transcript line the chat reads. */
interface ChatEntry {
    type?: unknown;
    uuid?: unknown;
    isMeta?: unknown;
    isSidechain?: unknown;
    isCompactSummary?: unknown;
    message?: {content?: unknown} | string;
}

/** Every chat message in these transcript lines, in order. A line that is not one is skipped. */
export function chatMessagesOf(lines: readonly string[]): ChatMessage[] {
    const messages: ChatMessage[] = [];
    for (const line of lines) {
        const entry = parseTranscriptLine(line) as ChatEntry | null;
        if (entry) messages.push(...messagesOfEntry(entry));
    }
    return messages;
}

function messagesOfEntry(entry: ChatEntry): ChatMessage[] {
    if (entry.type !== 'user' && entry.type !== 'assistant') return [];
    if (typeof entry.uuid !== 'string' || !entry.uuid) return [];
    if (entry.isMeta === true || entry.isSidechain === true || entry.isCompactSummary === true) return [];
    const uuid = entry.uuid;
    const content = typeof entry.message === 'string' ? entry.message : entry.message?.content;
    const blocks: Block[] =
        typeof content === 'string'
            ? [{type: 'text', text: content}]
            : Array.isArray(content)
              ? content.filter((block): block is Block => typeof block === 'object' && block !== null)
              : [];

    const messages: ChatMessage[] = [];
    blocks.forEach((block, index) => {
        const id = `${uuid}:${index}`;
        if (entry.type === 'user') {
            const text = block.type === 'text' && typeof block.text === 'string' ? promptText(block.text) : '';
            if (text) messages.push({id, role: 'user', text: capped(text, MAX_CHAT_TEXT)});
            return;
        }
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            messages.push({id, role: 'assistant', text: capped(block.text.trim(), MAX_CHAT_TEXT)});
        } else if (block.type === 'tool_use' && typeof block.name === 'string') {
            messages.push({id, role: 'tool', text: capped(toolLine(block.name, block.input), MAX_TOOL_LINE)});
        }
    });
    return messages;
}

/**
 * What the user typed, as the chat shows it; '' for a user entry that isn't a
 * prompt. A slash command reads as the command; a `!` shell line as itself;
 * its output, local command echoes and system reminders are left out.
 */
export function promptText(raw: string): string {
    if (/<local-command-stdout>|<local-command-stderr>|<local-command-caveat>|<bash-stdout>|<bash-stderr>/.test(raw))
        return '';
    const command = raw.match(/<command-name>([^<]*)<\/command-name>/);
    if (command) {
        const args = raw.match(/<command-args>([^<]*)<\/command-args>/)?.[1]?.trim();
        return [command[1].trim(), args].filter(Boolean).join(' ');
    }
    const bash = raw.match(/<bash-input>([\s\S]*?)<\/bash-input>/);
    if (bash) return `! ${bash[1].trim()}`;
    return raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

/** A tool call as one line: what it did and to what. */
export function toolLine(name: string, input: unknown): string {
    const field = (key: string): string => {
        const value = typeof input === 'object' && input !== null ? (input as Record<string, unknown>)[key] : undefined;
        return typeof value === 'string' ? firstLine(value) : '';
    };
    const said = (label: string, detail: string): string => (detail ? `${label}: ${detail}` : label);
    switch (name) {
        case 'Bash':
            return said('Ran', field('command'));
        case 'Read':
            return said('Read', shortPath(field('file_path')));
        case 'Edit':
        case 'MultiEdit':
            return said('Edited', shortPath(field('file_path')));
        case 'NotebookEdit':
            return said('Edited', shortPath(field('notebook_path')));
        case 'Write':
            return said('Wrote', shortPath(field('file_path')));
        case 'Grep':
        case 'Glob':
            return said('Searched', field('pattern'));
        case 'WebFetch':
            return said('Fetched', field('url'));
        case 'WebSearch':
            return said('Searched the web', field('query'));
        case 'Task':
        case 'Agent':
            return said('Agent', field('description'));
        case 'Skill':
            return said('Skill', field('skill'));
        case 'TodoWrite':
            return 'Updated the to-do list';
        case 'ExitPlanMode':
            return 'Proposed a plan';
        case 'AskUserQuestion':
            return 'Asked you a question';
        default:
            return `Used: ${name}`;
    }
}

/** The last two parts of a path: enough to tell the file, short enough for a line. */
function shortPath(path: string): string {
    const parts = path.split('/').filter(Boolean);
    return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`;
}

function firstLine(text: string): string {
    const lines = text.trim().split('\n');
    return lines.length > 1 ? `${lines[0].trimEnd()} …` : (lines[0] ?? '');
}

function capped(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** A piece of a growing transcript, as read from some byte onwards. */
export interface TranscriptPiece {
    /** The bytes read, decoded. */
    text: string;
    /** How many bytes that was. */
    bytes: number;
    /** More of the file follows: the read stopped at its limit, not at the end. */
    more: boolean;
    /** The read began inside a line (a tail read, or past a line too long to read whole), which is dropped. */
    midLine: boolean;
}

/** What can be taken from a piece now, and where the next read starts. */
export interface TakenLines {
    lines: string[];
    /** Bytes to move the read position on by. */
    consumed: number;
    /** Whether the next read begins inside a line. */
    midLine: boolean;
}

/**
 * The whole lines in a piece of a transcript the CLI is still appending to.
 * A last line without its newline is still being written and waits for the
 * next read; a line too long for one read is skipped (a huge tool result,
 * which the chat leaves out anyway).
 *
 * Bytes are counted from the side that starts on a line boundary, since a read
 * that began or stopped at an arbitrary byte may have split a character and
 * decoded it as a replacement, which counts as a different number of bytes.
 */
export function takeLines(piece: TranscriptPiece): TakenLines {
    const {text, bytes, more, midLine} = piece;
    const last = text.lastIndexOf('\n');
    if (midLine) {
        const first = text.indexOf('\n');
        // Still inside the dropped line: all of it goes.
        if (first < 0) return {lines: [], consumed: bytes, midLine: true};
        const lines = linesOf(text.slice(first + 1, last + 1));
        return {lines, consumed: bytes - utf8Length(text.slice(last + 1)), midLine: false};
    }
    if (last < 0) {
        // One line longer than a whole read: skip past it.
        if (more) return {lines: [], consumed: bytes, midLine: true};
        return {lines: [], consumed: 0, midLine: false};
    }
    const whole = text.slice(0, last + 1);
    return {lines: linesOf(whole), consumed: utf8Length(whole), midLine: false};
}

function linesOf(text: string): string[] {
    return text.split('\n').filter((line) => line.trim() !== '');
}

function utf8Length(text: string): number {
    return new TextEncoder().encode(text).length;
}
