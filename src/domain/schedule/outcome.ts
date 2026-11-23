/**
 * What one headless run came to, from what `claude -p --output-format json`
 * printed and how its process ended.
 *
 * The run goes through the user's login shell, which may print its own lines
 * first (a greeting, a version manager's notice), so the result is looked for
 * rather than assumed to be all of stdout.
 */
import type {RunStatus} from './manager';

/** The fields of the CLI's final JSON a run record needs. */
export interface CliResult {
    result: string | null;
    isError: boolean;
    subtype: string | null;
    sessionId: string | null;
}

/** The report's first line when a run found nothing to do; such runs arrive seen. */
export const NOTHING_TO_DO = 'Nothing to do.';

function asResult(value: unknown): CliResult | null {
    if (typeof value !== 'object' || value === null) return null;
    const v = value as Record<string, unknown>;
    if (!('result' in v) && !('is_error' in v) && v.type !== 'result') return null;
    return {
        result: typeof v.result === 'string' ? v.result : null,
        isError: v.is_error === true,
        subtype: typeof v.subtype === 'string' ? v.subtype : null,
        sessionId: typeof v.session_id === 'string' ? v.session_id : null,
    };
}

function tryParse(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

/** The CLI's final JSON in `stdout`, or null when there is none to be found. */
export function parseCliResult(stdout: string): CliResult | null {
    const whole = asResult(tryParse(stdout.trim()));
    if (whole) return whole;
    const lines = stdout.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line.startsWith('{')) continue;
        const found = asResult(tryParse(line));
        if (found) return found;
    }
    // A result object that does not start its line, after a shell's own output.
    const at = stdout.lastIndexOf('{"type":"result"');
    return at >= 0 ? asResult(tryParse(stdout.slice(at).trim())) : null;
}

/** How the run's process ended. */
export interface RunEnding {
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    /** It could not be started at all, and why. */
    startError: string | null;
    /** Its time limit stopped it. */
    limitHit: boolean;
    limitMinutes: number | null;
}

export interface RunOutcome {
    status: Extract<RunStatus, 'done' | 'failed' | 'limit'>;
    reason: string | null;
    report: string | null;
    seen: boolean;
    /** The session the CLI says it ran in, when it said. */
    sessionId: string | null;
}

function lastLine(text: string): string | null {
    const lines = text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    return lines.length > 0 ? lines[lines.length - 1] : null;
}

/** Whether a report says the run found nothing to do. */
export function foundNothingToDo(report: string | null): boolean {
    return report !== null && report.trimStart().startsWith(NOTHING_TO_DO);
}

/** The run's record once it ended: done, failed or stopped by its limit, its reason and report. */
export function runOutcome(ending: RunEnding): RunOutcome {
    const parsed = parseCliResult(ending.stdout);
    const report = parsed?.result?.trim() || null;
    const sessionId = parsed?.sessionId ?? null;
    if (ending.startError !== null) {
        return {status: 'failed', reason: `it could not start: ${ending.startError}`, report, seen: false, sessionId};
    }
    if (ending.limitHit) {
        const limit = ending.limitMinutes === null ? 'its limit' : `its ${ending.limitMinutes} min limit`;
        return {status: 'limit', reason: limit, report, seen: false, sessionId};
    }
    const detail = lastLine(ending.stderr);
    if (ending.exitCode !== 0) {
        const how = ending.exitCode === null ? `killed by ${ending.signal ?? 'a signal'}` : `exit ${ending.exitCode}`;
        return {status: 'failed', reason: detail ? `${how}: ${detail}` : how, report, seen: false, sessionId};
    }
    if (parsed?.isError) {
        const why =
            (parsed.subtype && parsed.subtype !== 'success' ? parsed.subtype : null) ??
            detail ??
            'it ended with an error';
        return {status: 'failed', reason: why, report, seen: false, sessionId};
    }
    return {status: 'done', reason: null, report, seen: foundNothingToDo(report), sessionId};
}
