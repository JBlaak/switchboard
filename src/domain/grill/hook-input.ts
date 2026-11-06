/**
 * What the grilling card learns from Claude's hooks, read out of their JSON.
 *
 * Four hooks feed it. Stop ends a turn: its body names the session's
 * transcript, whose tail holds every text block the turn wrote, and may list
 * the background tasks still running. UserPromptSubmit carries the prompt that
 * went in, so the card can tell its own asks from a real reply. SubagentStart
 * and SubagentStop say a research agent began or finished.
 *
 * Everything here is pure: the hook server reads the request and the
 * transcript's tail and hands the text in. Every field is read defensively,
 * since the CLI's hook payloads grow and change between versions.
 */
import type {EndedTurn} from './model';

/** How much of a transcript's end is read to find the turn that just ended. */
export const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;

/** What a Stop hook request carried, once checked. */
export interface StopHookInput {
    /** The session's transcript, when the CLI named one. */
    transcriptPath: string | null;
    /** The turn's last message, as the CLI reports it. */
    lastMessage: string | null;
    /** The ids of the background subagents still running, or null when the CLI did not say. */
    backgroundAgents: string[] | null;
}

/** Null for anything that is not a Stop hook request. */
export function parseStopHook(body: unknown): StopHookInput | null {
    if (!isRecord(body) || body.hook_event_name !== 'Stop') return null;
    return {
        transcriptPath: typeof body.transcript_path === 'string' && body.transcript_path ? body.transcript_path : null,
        lastMessage: typeof body.last_assistant_message === 'string' ? body.last_assistant_message : null,
        backgroundAgents: backgroundAgentIds(body.background_tasks),
    };
}

/**
 * The ids of the subagents among a Stop's `background_tasks`.
 *
 * The shape is not documented, so it is read loosely: an entry counts when its
 * `type`, `kind` or `task_type` mentions an agent (`subagent`, `local_agent`),
 * and its id is the first of `id`, `task_id`, `agent_id` it has. Null when the
 * field is absent or not a list: the CLI said nothing, which is not the same
 * as "none running".
 */
export function backgroundAgentIds(tasks: unknown): string[] | null {
    if (!Array.isArray(tasks)) return null;
    const ids: string[] = [];
    for (const task of tasks) {
        if (!isRecord(task)) continue;
        const kind = firstString(task, ['type', 'kind', 'task_type', 'taskType']);
        if (!kind || !/agent/i.test(kind)) continue;
        const id = firstString(task, ['id', 'task_id', 'taskId', 'agent_id', 'agentId']);
        if (id) ids.push(id);
    }
    return ids;
}

/** A SubagentStart or SubagentStop hook request: which agent, and whether it began or ended. */
export interface SubagentHookInput {
    event: 'start' | 'stop';
    agentId: string;
}

/** Null for anything that is not a SubagentStart or SubagentStop with an agent id. */
export function parseSubagentHook(body: unknown): SubagentHookInput | null {
    if (!isRecord(body)) return null;
    const event =
        body.hook_event_name === 'SubagentStart' ? 'start' : body.hook_event_name === 'SubagentStop' ? 'stop' : null;
    const agentId = firstString(body, ['agent_id', 'agentId']);
    return event && agentId ? {event, agentId} : null;
}

/**
 * The prompt a UserPromptSubmit hook request carried; '' when it carried none
 * (the prompt still went in), null for anything else.
 */
export function parsePromptHook(body: unknown): string | null {
    if (!isRecord(body) || body.hook_event_name !== 'UserPromptSubmit') return null;
    return typeof body.prompt === 'string' ? body.prompt : '';
}

/**
 * The turn a Stop ended, from the transcript's last lines when they agree with
 * the Stop's own last message, or else from that message alone.
 *
 * `lines` is the transcript's tail split into lines (null when it could not be
 * read); the first may be cut off mid-line and is then skipped as malformed.
 * The transcript is trusted only when its turn ends on the text the Stop
 * reports (or the Stop reports none, as when the turn's last message was a
 * tool call), so a transcript that has not caught up yet cannot pass off an
 * older turn as this one. The fallback names its one block `stop-<hash>`, using
 * `hash` (a short digest of the text), so the same text gets the same id.
 * With no text at all the turn is empty.
 */
export function endedTurn(
    lines: string[] | null,
    lastMessage: string | null,
    hash: (text: string) => string,
): EndedTurn {
    const said = lastMessage?.trim() ? lastMessage : null;
    const read = lines ? turnFromTranscript(lines) : null;
    const last = read?.texts.at(-1);
    if (read && last && (said === null || agrees(said, last.text))) return read;
    return said === null ? {texts: []} : {texts: [{id: `stop-${hash(said)}`, text: said}]};
}

/**
 * The text blocks of the transcript's last turn, in order.
 *
 * Walks back from the end to the turn's start: a user line that is a prompt
 * (text, not a tool result), or Claude being woken by a background task (a
 * `<task-notification>` or `<agent-message>`, which the CLI may mark as meta).
 * Other meta user lines (a skill's instructions, a command's caveat) do not
 * start a turn. Subagent lines (`isSidechain`) are ignored. Each block's id is
 * its line's `uuid`, with `#1`, `#2`, … when a line holds several. When the
 * tail ends before the turn's start, the blocks it does hold are the turn.
 * Null when no line in it could be read at all.
 */
export function turnFromTranscript(lines: string[]): EndedTurn | null {
    const reversed: {id: string; text: string}[] = [];
    let readable = false;
    for (let i = lines.length - 1; i >= 0; i--) {
        const entry = parseLine(lines[i]);
        if (!entry) continue;
        readable = true;
        if (entry.isSidechain === true) continue;
        if (startsTurn(entry)) break;
        if (entry.type !== 'assistant') continue;
        const texts = assistantTexts(entry);
        const uuid = typeof entry.uuid === 'string' && entry.uuid ? entry.uuid : null;
        for (let n = texts.length - 1; n >= 0; n--) {
            const base = uuid ?? `line-${i}`;
            reversed.push({id: texts.length > 1 ? `${base}#${n + 1}` : base, text: texts[n]});
        }
    }
    return readable ? {texts: reversed.reverse()} : null;
}

/** Whether the Stop's last message is the transcript's last block (or ends with it), whitespace aside. */
function agrees(lastMessage: string, text: string): boolean {
    const message = lastMessage.trim();
    const block = text.trim();
    return message === block || message.endsWith(block);
}

function startsTurn(entry: Record<string, unknown>): boolean {
    if (entry.type !== 'user') return false;
    const message = entry.message;
    const content = isRecord(message) ? message.content : message;
    let text: string;
    if (typeof content === 'string') {
        text = content;
    } else if (Array.isArray(content)) {
        if (content.length === 0 || content.some((block) => isRecord(block) && block.type === 'tool_result')) {
            return false;
        }
        text = content
            .filter((block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
            .map((block) => (block as {text: string}).text)
            .join('\n');
    } else {
        return false;
    }
    if (entry.isMeta === true) return /<task-notification>|<agent-message\b/.test(text);
    return true;
}

function assistantTexts(entry: Record<string, unknown>): string[] {
    const message = entry.message;
    if (!isRecord(message) || !Array.isArray(message.content)) return [];
    return message.content
        .filter((block): block is {type: 'text'; text: string} => isRecord(block) && block.type === 'text')
        .map((block) => block.text)
        .filter((text) => typeof text === 'string' && text.trim() !== '');
}

function parseLine(line: string): Record<string, unknown> | null {
    if (!line.trim()) return null;
    try {
        const parsed: unknown = JSON.parse(line);
        return isRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value) return value;
    }
    return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
