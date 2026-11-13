/**
 * Checking that a decoded frame really is a MacMessage (#276).
 *
 * The framing hands the agent parsed JSON and nothing more, so anything could
 * arrive: a stale client from another version, a bug, or plain garbage written
 * to the socket. The router runs every message through `parseMacMessage`
 * before a part sees it, so the parts can trust the types they are handed and
 * need no checks of their own.
 *
 * The checks are deliberately shallow where the protocol nests a shape owned
 * elsewhere (`SessionOptions`, the hook's reply JSON): those are checked to be
 * objects, and the part that reads them reads their fields defensively, as a
 * local launch does. Everything the router or a part keys on (types, ids,
 * numbers, enums) is checked exactly, and unknown extra fields are allowed, so
 * an optional field added later without a protocol bump still passes.
 */
import {AGENT_CLOSE, TRANSCRIPT_QUERY_METHODS, type AgentCloseCode, type MacMessage} from './protocol';

/** What `parseMacMessage` found: the message, or why it is not one. */
export type ParsedMacMessage =
    | {ok: true; message: MacMessage}
    /**
     * `unknown` is set for a well-formed message of a type this agent does not
     * know, carrying its request id when it has one: a newer Mac asking an older
     * agent something it learnt later, which is answered rather than fatal.
     */
    | {ok: false; reason: string; unknown?: {type: string; requestId?: string}};

type Fields = Record<string, unknown>;

/** One field's check; answers why the field is wrong, or null when it is fine. */
type Check = (value: unknown) => string | null;

const isObject = (value: unknown): value is Fields =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const string: Check = (v) => (typeof v === 'string' ? null : 'must be a string');
const nonEmptyString: Check = (v) => (typeof v === 'string' && v.length > 0 ? null : 'must be a non-empty string');
const boolean: Check = (v) => (typeof v === 'boolean' ? null : 'must be a boolean');
const integer: Check = (v) => (Number.isInteger(v) ? null : 'must be an integer');
/** Terminal sizes: a PTY rejects zero or negative, and anything past 16 bits is nonsense. */
const dimension: Check = (v) =>
    Number.isInteger(v) && (v as number) > 0 && (v as number) <= 0xffff ? null : 'must be a positive integer';
/** A sequence number, or -1 for "nothing yet". */
const seq: Check = (v) => (Number.isInteger(v) && (v as number) >= -1 ? null : 'must be an integer ≥ -1');
const object: Check = (v) => (isObject(v) ? null : 'must be an object');
const oneOf =
    (...values: readonly string[]): Check =>
    (v) =>
        typeof v === 'string' && values.includes(v) ? null : `must be one of ${values.join(', ')}`;
const optional =
    (check: Check): Check =>
    (v) =>
        v === undefined ? null : check(v);
const arrayOf =
    (check: Check): Check =>
    (v) => {
        if (!Array.isArray(v)) return 'must be an array';
        for (let i = 0; i < v.length; i++) {
            const wrong = check(v[i]);
            if (wrong) return `[${i}] ${wrong}`;
        }
        return null;
    };
const shape =
    (fields: Record<string, Check>): Check =>
    (v) => {
        if (!isObject(v)) return 'must be an object';
        for (const [name, check] of Object.entries(fields)) {
            const wrong = check(v[name]);
            if (wrong) return `.${name} ${wrong}`;
        }
        return null;
    };

const closeCodes = Object.values(AGENT_CLOSE) as readonly AgentCloseCode[];

const configFile = shape({path: string, contentBase64: string, mode: integer});
const hostSettingsPatch = shape({
    instructions: optional(string),
    copyConfig: optional(boolean),
    baseFolder: optional(string),
    scheduleDirs: optional(arrayOf(nonEmptyString)),
    mergingHost: optional(boolean),
});

/**
 * Every Mac → agent message type, with the fields it must carry. Keyed by
 * `MacMessage['type']` so adding a message to the protocol without a check
 * here is a compile error.
 */
const MESSAGE_FIELDS: Record<MacMessage['type'], Record<string, Check>> = {
    hello: {protocol: integer, appVersion: string},
    open: {
        requestId: nonEmptyString,
        sessionId: nonEmptyString,
        kind: oneOf('claude', 'shell'),
        dir: string,
        isNew: boolean,
        options: optional(object),
        command: optional(string),
        cols: dimension,
        rows: dimension,
    },
    attach: {sessionId: nonEmptyString, since: seq, cols: dimension, rows: dimension},
    input: {sessionId: nonEmptyString, data: string},
    resize: {sessionId: nonEmptyString, cols: dimension, rows: dimension},
    signal: {sessionId: nonEmptyString, signal: oneOf('SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP')},
    'list-sessions': {requestId: nonEmptyString},
    'ask-reply': {hookId: nonEmptyString, json: object},
    'archive-reply': {hookId: nonEmptyString, outcome: shape({ok: boolean, message: string})},
    'get-host-settings': {requestId: nonEmptyString},
    'set-host-settings': {requestId: nonEmptyString, settings: hostSettingsPatch},
    'check-tools': {requestId: nonEmptyString},
    'copy-config': {requestId: nonEmptyString, files: arrayOf(configFile), removed: arrayOf(string)},
    'upload-begin': {uploadId: nonEmptyString, size: integer},
    'upload-chunk': {uploadId: nonEmptyString, dataBase64: string},
    'upload-end': {requestId: nonEmptyString, uploadId: nonEmptyString, sha256: nonEmptyString},
    handoff: {
        requestId: nonEmptyString,
        repo: shape({name: nonEmptyString, origin: nonEmptyString, github: optional(string)}),
        branch: nonEmptyString,
        headOid: nonEmptyString,
        bundleUploadId: optional(string),
        patchUploadId: optional(string),
        files: arrayOf(shape({path: nonEmptyString, contentBase64: string, mode: integer})),
        worktree: optional(nonEmptyString),
    },
    'run-tool': {
        requestId: nonEmptyString,
        tool: oneOf('git', 'gh'),
        cwd: nonEmptyString,
        args: arrayOf(string),
        stdinBase64: optional(string),
        timeoutMs: integer,
    },
    'read-file': {requestId: nonEmptyString, path: nonEmptyString, maxBytes: integer},
    'stat-files': {requestId: nonEmptyString, paths: arrayOf(nonEmptyString)},
    'watch-dir': {watchId: nonEmptyString, dir: nonEmptyString},
    'unwatch-dir': {watchId: nonEmptyString},
    'transcript-query': {
        requestId: nonEmptyString,
        method: oneOf(...TRANSCRIPT_QUERY_METHODS),
        args: arrayOf((v) => (v === undefined ? 'must not be undefined' : null)),
    },
    'list-transcripts': {requestId: nonEmptyString, dirs: arrayOf(nonEmptyString), since: optional(integer)},
    'place-upload': {requestId: nonEmptyString, uploadId: nonEmptyString, name: nonEmptyString},
    'list-self-archived': {requestId: nonEmptyString},
    'forget-self-archived': {requestId: nonEmptyString, sessionIds: arrayOf(nonEmptyString)},
    'list-self-started': {requestId: nonEmptyString},
    'forget-self-started': {requestId: nonEmptyString, sessionIds: arrayOf(nonEmptyString)},
    'get-transcript': {requestId: nonEmptyString, sessionId: nonEmptyString},
    'transcript-tail': {requestId: nonEmptyString, sessionId: nonEmptyString, bytes: integer},
    'set-transcript-aside': {requestId: nonEmptyString, sessionId: nonEmptyString},
    'read-transcript': {requestId: nonEmptyString, sessionId: nonEmptyString, offset: integer, maxBytes: integer},
    'import-transcript': {
        requestId: nonEmptyString,
        sessionId: nonEmptyString,
        dir: nonEmptyString,
        uploadId: nonEmptyString,
    },
    'copy-status': {requestId: nonEmptyString, dir: nonEmptyString},
    'push-branch': {requestId: nonEmptyString, dir: nonEmptyString, branch: nonEmptyString},
    'remove-copy': {requestId: nonEmptyString, dir: nonEmptyString},
    bye: {code: oneOf(...closeCodes), reason: optional(string)},
};

const isKnownType = (type: string): type is MacMessage['type'] => Object.hasOwn(MESSAGE_FIELDS, type);

/**
 * Whether `value`, one decoded message frame, is a well-formed MacMessage.
 *
 * Only the shape is checked, never the meaning: a `hello` with the wrong
 * version passes here and is turned away by the router, and an `input` for a
 * session that does not exist is the session part's to ignore.
 */
export function parseMacMessage(value: unknown): ParsedMacMessage {
    if (!isObject(value)) return {ok: false, reason: 'a message must be a JSON object'};
    const type = value.type;
    if (typeof type !== 'string') return {ok: false, reason: 'a message must have a string type'};
    if (!isKnownType(type)) {
        const requestId = typeof value.requestId === 'string' && value.requestId ? value.requestId : undefined;
        return {ok: false, reason: `unknown message type: ${type}`, unknown: {type, ...(requestId ? {requestId} : {})}};
    }
    const wrong = shape(MESSAGE_FIELDS[type])(value);
    if (wrong) return {ok: false, reason: `malformed ${type}: ${wrong.replace(/^\./, '')}`};
    return {ok: true, message: value as unknown as MacMessage};
}
