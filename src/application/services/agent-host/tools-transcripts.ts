/**
 * `transcript-query`: the VM's own transcript store, asked by the Mac (#276
 * stage 4, #296).
 *
 * The Mac's session work page and Plan tab read a session's transcripts
 * through the TranscriptStore port. For a VM session that port is a stand-in
 * that sends each call here, and this answers it with the same
 * FileTranscriptStore the Mac uses, over the VM's `~/.claude/projects`. So a
 * VM session's locations, issue mentions and plan handover read exactly as a
 * local one's do.
 *
 * Only the read methods in TRANSCRIPT_QUERY_METHODS are callable (the router's
 * validator refuses any other name before it gets here), and each one's
 * arguments are checked against its signature below, not just passed on: a
 * folder or a session id becomes part of a path, so neither may hold a `/` or
 * be `..`, and a byte limit is capped so one query can't read a whole
 * multi-gigabyte file into one frame.
 *
 * ## What goes back
 *
 * Every method's return value is already plain JSON (strings, numbers, null,
 * arrays and objects of those), so `toJson` converts nothing today. It is
 * still spelled out per method, so a method that ever returns a Map, a Set or
 * a Date has to be converted here on purpose rather than silently arriving on
 * the Mac as `{}`. The shapes are:
 *
 * - `locations` → `TranscriptLocation[]`: `[{cwd, branch, fromSubagent}]`,
 *   `cwd` absolute on the VM.
 * - `readSession` → `Session | null`, with `folder` the VM's folder name and
 *   `projectPath` as the Mac passed it, and `textContent` capped at
 *   TRANSCRIPT_TEXT_CAP_CHARS.
 * - `issueMentions` → `IssueRef[]`: `[{repository, number}]`.
 * - `resolveProjectPath` → `string | null`, absolute on the VM.
 * - `readHeadLines` → `string[]`.
 * - `readTail` → `string`.
 * - `sessionMtimeMs` → `number | null`.
 */
import {TRANSCRIPT_TEXT_CAP_CHARS, TOOL_OUTPUT_CAP_BYTES} from '../../../domain/agent/protocol';
import type {
    TranscriptAnswerMessage,
    TranscriptQueryMessage,
    TranscriptQueryMethod,
} from '../../../domain/agent/protocol';
import type {TranscriptStore} from '../../ports/transcript-store';

/** The part of the transcript store a query may reach: its read methods named in the contract. */
export type QueryableTranscripts = Pick<TranscriptStore, TranscriptQueryMethod>;

/**
 * What a session id may look like before it goes into a path. Claude's are
 * UUIDs; this is looser, as the transcripts part's is, but has no `/` and no
 * `.`, so it can never name a file outside its folder.
 */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * What a folder name may look like: one segment under `~/.claude/projects`.
 * An encoded project path is letters, digits and `-`; `.` and `_` are allowed
 * for older encodings, but never a `/`, and `.`, `..` and `.git` are refused.
 */
const FOLDER = /^[A-Za-z0-9._-]{1,255}$/;
const NOT_A_FOLDER = new Set(['.', '..', '.git']);

/**
 * The most a head or tail read takes. A tail is for the plan-handover check
 * and a head for the cheap signal reads; neither needs more, and a string
 * this size still fits a frame however it is escaped.
 */
export const QUERY_MAX_BYTES = TOOL_OUTPUT_CAP_BYTES / 4;

/** One argument's kind, checked before the call. */
type ArgKind = 'folder' | 'sessionId' | 'text' | 'byteLimit';

/** Each method's arguments, in order, as the TranscriptStore port declares them. */
const SIGNATURES: Record<TranscriptQueryMethod, readonly ArgKind[]> = {
    locations: ['folder', 'sessionId'],
    readSession: ['folder', 'sessionId', 'text'],
    issueMentions: ['folder', 'sessionId', 'text'],
    resolveProjectPath: ['folder'],
    readHeadLines: ['folder', 'sessionId', 'byteLimit'],
    readTail: ['folder', 'sessionId', 'byteLimit'],
    sessionMtimeMs: ['folder', 'sessionId'],
};

/** Why `value` can't be an argument of `kind`; null when it can. */
function wrongArg(kind: ArgKind, value: unknown): string | null {
    switch (kind) {
        case 'folder':
            return typeof value === 'string' && FOLDER.test(value) && !NOT_A_FOLDER.has(value) ? null : 'a folder name';
        case 'sessionId':
            return typeof value === 'string' && SESSION_ID.test(value) ? null : 'a session id';
        case 'text':
            return typeof value === 'string' ? null : 'a string';
        case 'byteLimit':
            return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? null : 'a byte count';
    }
}

/** The checked arguments, or why they are wrong. */
function checkArgs(method: TranscriptQueryMethod, args: unknown[]): {ok: true} | {ok: false; error: string} {
    const kinds = SIGNATURES[method];
    if (args.length !== kinds.length) {
        return {ok: false, error: `${method} takes ${kinds.length} argument(s), got ${args.length}`};
    }
    for (let i = 0; i < kinds.length; i++) {
        const wrong = wrongArg(kinds[i], args[i]);
        if (wrong) return {ok: false, error: `${method}: argument ${i + 1} must be ${wrong}`};
    }
    return {ok: true};
}

const str = (value: unknown): string => value as string;
const bytes = (value: unknown): number => Math.min(value as number, QUERY_MAX_BYTES);

/**
 * Call the method on the checked arguments and turn its answer into JSON.
 * Each case is where that method's return value would be converted.
 */
function call(store: QueryableTranscripts, method: TranscriptQueryMethod, a: unknown[], textCap: number): unknown {
    switch (method) {
        case 'locations':
            return store.locations(str(a[0]), str(a[1])).map(({cwd, branch, fromSubagent}) => ({
                cwd,
                branch,
                fromSubagent,
            }));
        case 'readSession': {
            const session = store.readSession(str(a[0]), str(a[1]), str(a[2]));
            if (session?.textContent && session.textContent.length > textCap) {
                return {...session, textContent: session.textContent.slice(0, textCap)};
            }
            return session;
        }
        case 'issueMentions':
            return store.issueMentions(str(a[0]), str(a[1]), str(a[2])).map(({repository, number}) => ({
                repository,
                number,
            }));
        case 'resolveProjectPath':
            return store.resolveProjectPath(str(a[0]));
        case 'readHeadLines':
            return store.readHeadLines(str(a[0]), str(a[1]), bytes(a[2]));
        case 'readTail':
            return store.readTail(str(a[0]), str(a[1]), bytes(a[2]));
        case 'sessionMtimeMs':
            return store.sessionMtimeMs(str(a[0]), str(a[1]));
    }
}

/** The answer to one query; a throw from the store is an `ok:false` answer, never a crash. */
export function answerTranscriptQuery(
    store: QueryableTranscripts,
    message: TranscriptQueryMessage,
    textCapChars: number = TRANSCRIPT_TEXT_CAP_CHARS,
): TranscriptAnswerMessage {
    const {requestId, method, args} = message;
    // The router's validator has checked the name; this guards a caller that skipped it.
    if (!Object.hasOwn(SIGNATURES, method)) {
        return {type: 'transcript-answer', requestId, ok: false, error: `unknown method: ${String(method)}`};
    }
    const checked = checkArgs(method, args);
    if (!checked.ok) return {type: 'transcript-answer', requestId, ok: false, error: checked.error};
    try {
        const result = call(store, method, args, textCapChars);
        // `undefined` would vanish from the JSON and leave the Mac guessing; null says "nothing".
        return {type: 'transcript-answer', requestId, ok: true, result: result ?? null};
    } catch (error) {
        return {
            type: 'transcript-answer',
            requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
