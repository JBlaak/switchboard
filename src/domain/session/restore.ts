/**
 * Bringing local sessions back after a restart or a reboot.
 *
 * A local session is a child of the app, so it dies when Switchboard quits,
 * crashes or the Mac shuts down, and nothing else remembers it was running: a
 * transcript ends the same way whether its session was stopped or cut off. So
 * Switchboard keeps a record of the live sessions, and resumes what is in it
 * when it starts again. These are the rules of that record and of reading
 * where a cut-off session's turn stood.
 */

/** A local Claude session that was live, as the record keeps it. */
export interface LiveSessionEntry {
    sessionId: string;
    /** The folder it was launched in, which it is resumed in again. */
    projectPath: string;
    /** ISO-8601; the record is restored in this order. */
    startedAt: string;
}

/** The record as stored, read defensively: anything malformed is left out. */
export function parseLiveSessions(stored: unknown): LiveSessionEntry[] {
    if (!Array.isArray(stored)) return [];
    return stored.filter(
        (entry): entry is LiveSessionEntry =>
            !!entry &&
            typeof entry === 'object' &&
            typeof (entry as LiveSessionEntry).sessionId === 'string' &&
            typeof (entry as LiveSessionEntry).projectPath === 'string' &&
            typeof (entry as LiveSessionEntry).startedAt === 'string',
    );
}

/**
 * The record with this session live. A session already in it keeps its first
 * start, so a resumed session stays where it was in the restore order.
 */
export function withLiveSession(entries: readonly LiveSessionEntry[], entry: LiveSessionEntry): LiveSessionEntry[] {
    const existing = entries.find((e) => e.sessionId === entry.sessionId);
    const kept = existing ? {...entry, startedAt: existing.startedAt} : entry;
    return [...entries.filter((e) => e.sessionId !== entry.sessionId), kept];
}

/** The record without any of these ids. */
export function withoutLiveSessions(
    entries: readonly LiveSessionEntry[],
    sessionIds: readonly string[],
): LiveSessionEntry[] {
    return entries.filter((e) => !sessionIds.includes(e.sessionId));
}

/** The record with a re-keyed session (a fork, an accepted plan) under the id it goes by now. */
export function rekeyLiveSession(
    entries: readonly LiveSessionEntry[],
    oldId: string,
    newId: string,
): LiveSessionEntry[] {
    const entry = entries.find((e) => e.sessionId === oldId);
    if (!entry) return [...entries];
    return withLiveSession(withoutLiveSessions(entries, [oldId]), {...entry, sessionId: newId});
}

/** The order the record is restored in: first started first. */
export function restoreOrder(entries: readonly LiveSessionEntry[]): LiveSessionEntry[] {
    return [...entries].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** Where a cut-off session's last turn stood: mid tool call or on a prompt for one. */
export interface Interruption {
    /** The tool whose use has no result; null when the name was not written. */
    tool: string | null;
}

interface TranscriptLine {
    type?: unknown;
    isSidechain?: unknown;
    isMeta?: unknown;
    message?: {content?: unknown};
}

interface ContentBlock {
    type?: unknown;
    id?: unknown;
    name?: unknown;
    tool_use_id?: unknown;
}

/**
 * Whether a transcript's tail ends with a tool use that has no result.
 *
 * That is a turn cut off while a tool ran, or while it waited on a permission
 * prompt or a question (AskUserQuestion is a tool too); once the process is
 * gone the two can't be told apart, so both count. A new prompt closes what
 * came before it, and the subagents' lines are not the session's own turn.
 *
 * The tail is a byte window, so its first line may be cut; any line that does
 * not parse is skipped. A result for a use that began before the window is
 * simply nothing to close.
 */
export function interruptionFromTail(tail: string): Interruption | null {
    const open = new Map<string, string | null>();

    for (const raw of tail.split('\n')) {
        const line = parseLine(raw);
        if (!line || line.isSidechain === true) continue;
        const content = line.message?.content;

        if (line.type === 'assistant' && Array.isArray(content)) {
            for (const block of content as ContentBlock[]) {
                if (block?.type !== 'tool_use' || typeof block.id !== 'string') continue;
                open.set(block.id, typeof block.name === 'string' ? block.name : null);
            }
        } else if (line.type === 'user') {
            const blocks = Array.isArray(content) ? (content as ContentBlock[]) : [];
            const results = blocks.filter((block) => block?.type === 'tool_result');
            if (results.length === 0) {
                // A prompt: whatever was open before it is not this turn's. A
                // meta line (a command's caveat, say) is no prompt.
                if (line.isMeta !== true) open.clear();
                continue;
            }
            for (const result of results) {
                if (typeof result.tool_use_id === 'string') open.delete(result.tool_use_id);
            }
        }
    }

    if (open.size === 0) return null;
    const tool = [...open.values()].at(-1) ?? null;
    return {tool};
}

/** What a restored session that was cut off says about itself. */
export function interruptedLabel(interruption: Interruption): string {
    return interruption.tool ? `Interrupted by restart: ${interruption.tool}` : 'Interrupted by restart';
}

function parseLine(raw: string): TranscriptLine | null {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('{')) return null;
    try {
        const parsed: unknown = JSON.parse(trimmed);
        return parsed && typeof parsed === 'object' ? (parsed as TranscriptLine) : null;
    } catch {
        return null;
    }
}
