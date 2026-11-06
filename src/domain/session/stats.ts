/**
 * A session's stats, for the session tray's Session group (#341, epic #338):
 * how much of the context window it has used, how many messages it holds, when
 * it started, the branch it is on and the shell it runs in.
 *
 * The rules here are pure: which transcript line says how full the context
 * is, and which window that is measured against. Reading the transcript, git
 * and the settings is the service's (`SessionStatsService`).
 */
import {parseTranscriptLine} from './transcript';

/** What `getSessionStats` answers. Every field is null when it is not known. */
export interface SessionStats {
    /**
     * How full the context window is, 0–1: the last main-thread assistant
     * turn's input, cache-read and cache-creation tokens over the model's
     * window. Null when no turn has reported usage yet (not 0).
     */
    contextUsed: number | null;
    /** Messages exchanged, counted the way the session list counts them. */
    messageCount: number | null;
    /**
     * ISO-8601: when the session's terminal started, or for a session that is
     * not running, the transcript's first entry. Running time is now minus this.
     */
    startedAt: string | null;
    /** The branch checked out where the session works now; null on a detached HEAD or outside git. */
    branch: string | null;
    /** The shell profile the header names: null for the default profile, and for a remote session. */
    shell: string | null;
}

/** The window every model has. */
export const STANDARD_CONTEXT_WINDOW = 200_000;
/** The window a `[1m]` model has. */
export const LONG_CONTEXT_WINDOW = 1_000_000;

/** The context a turn was sent with, as its usage reports it. */
export interface ContextUsage {
    /** The model the turn ran on, as the transcript names it; null when it does not. */
    model: string | null;
    /** Input + cache-read + cache-creation tokens: everything the turn was sent. */
    tokens: number;
    /**
     * The most any main-thread turn read alongside it was sent. Above 200k it
     * proves the long window even after a compaction brought `tokens` down.
     */
    peakTokens: number;
}

/** The model the CLI writes for a turn it made up itself (an error, an interruption). */
const SYNTHETIC_MODEL = '<synthetic>';

interface UsageEntry {
    type?: unknown;
    isSidechain?: unknown;
    message?: {model?: unknown; usage?: Record<string, unknown>} | unknown;
}

function count(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** The context one transcript entry reports, or null when it reports none. */
function usageOf(entry: UsageEntry): {model: string | null; tokens: number} | null {
    if (entry.type !== 'assistant' || entry.isSidechain === true) return null;
    const message = entry.message;
    if (!message || typeof message !== 'object') return null;
    const {model, usage} = message as {model?: unknown; usage?: Record<string, unknown>};
    if (model === SYNTHETIC_MODEL || !usage || typeof usage !== 'object') return null;
    const tokens =
        count(usage.input_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens);
    if (tokens === 0) return null;
    return {model: typeof model === 'string' && model ? model : null, tokens};
}

/**
 * The context the last main-thread assistant turn in `lines` was sent with,
 * or null when none reported usage. A subagent's turn (`isSidechain`) and a
 * turn the CLI made up (model `<synthetic>`, no tokens) are passed over: they
 * say nothing about the session's own context. Lines cut off by a tail read
 * parse as nothing.
 */
export function lastContextUsage(lines: readonly string[]): ContextUsage | null {
    let last: {model: string | null; tokens: number} | null = null;
    let peakTokens = 0;
    for (const line of lines) {
        const entry = parseTranscriptLine(line) as UsageEntry | null;
        const usage = entry ? usageOf(entry) : null;
        if (!usage) continue;
        last = usage;
        peakTokens = Math.max(peakTokens, usage.tokens);
    }
    return last ? {...last, peakTokens} : null;
}

/**
 * The context window a turn ran in: 1M for a `[1m]` model, else 200k.
 *
 * The CLI writes the bare model id into the transcript (`claude-opus-5-5`,
 * not `claude-opus-5-5[1m]`), so the suffix is rarely there to see. A
 * session that has sent more than 200k tokens can only be running in the
 * long window, so that counts as `[1m]` too.
 */
export function contextWindowFor(usage: ContextUsage): number {
    if (usage.model && /\[1m\]/i.test(usage.model)) return LONG_CONTEXT_WINDOW;
    return usage.peakTokens > STANDARD_CONTEXT_WINDOW ? LONG_CONTEXT_WINDOW : STANDARD_CONTEXT_WINDOW;
}

/** How full the context window is, 0–1, or null when nothing has reported usage. */
export function contextFraction(usage: ContextUsage | null): number | null {
    if (!usage) return null;
    return Math.min(1, usage.tokens / contextWindowFor(usage));
}

/** The `cwd` of the last line in `lines` that names one: where the session works now. */
export function lastCwd(lines: readonly string[]): string | null {
    for (let i = lines.length - 1; i >= 0; i--) {
        const entry = parseTranscriptLine(lines[i]) as {cwd?: unknown} | null;
        if (entry && typeof entry.cwd === 'string' && entry.cwd) return entry.cwd;
    }
    return null;
}
