/**
 * Reading and writing the Phone access wire format (#194): the phone's JSON
 * messages, the binary terminal frames, and the pairing QR code's text.
 *
 * Everything a phone sends goes through `parseClientMessage` before the
 * service sees it, and anything it doesn't vouch for is null, which the
 * listener answers with CLOSE.protocolError. A paired phone is trusted to be
 * who it says, not to be bug-free or uncompromised, so every field is checked
 * for type and size: an id the length of a novel or a resize to a million
 * columns never reaches the PTY. Fields the parser doesn't know are dropped
 * rather than refused, since protocol.ts allows adding optional fields
 * without a version bump.
 */
import type { Answers } from '../questions/question';
import type { ClientMessage, PairingInvite } from './protocol';

/** A whole text frame; larger than any legitimate message, by a wide margin. */
export const MAX_MESSAGE_CHARS = 512 * 1024;

/** Session, tool use and request ids. */
const MAX_ID = 256;
const MAX_APP_VERSION = 64;
const MAX_DEVICE_NAME = 100;
/** Generous on purpose: a wrong-length code must reach the pairing rules and count as a wrong guess. */
const MAX_CODE = 64;
const MAX_PATH = 4096;
/** Prompt-box text, an Ask Patch request, a prompt, one answer. */
const MAX_TEXT = 100_000;
const MAX_ANSWERS = 50;
/** No phone has a terminal this big; the cap keeps a bad size from reaching the PTY. */
export const MAX_TERMINAL_CELLS = 1000;

/** The session id's byte length is a u16 in the frame header. */
const MAX_FRAME_SESSION_ID_BYTES = 0xffff;

export function parseClientMessage(text: string): ClientMessage | null {
  if (typeof text !== 'string' || text.length > MAX_MESSAGE_CHARS) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;

  switch (raw.type) {
    case 'hello': {
      if (!isProtocolNumber(raw.protocol) || !isText(raw.appVersion, MAX_APP_VERSION)) return null;
      return { type: 'hello', protocol: raw.protocol, appVersion: raw.appVersion };
    }
    case 'pair': {
      if (!isText(raw.code, MAX_CODE) || !isText(raw.deviceName, MAX_DEVICE_NAME) || !raw.deviceName.trim()) return null;
      return { type: 'pair', code: raw.code, deviceName: raw.deviceName };
    }
    case 'attach':
    case 'size': {
      if (!isText(raw.sessionId, MAX_ID) || !isCells(raw.cols) || !isCells(raw.rows)) return null;
      return { type: raw.type, sessionId: raw.sessionId, cols: raw.cols, rows: raw.rows };
    }
    case 'detach':
    case 'use-here': {
      if (!isText(raw.sessionId, MAX_ID)) return null;
      return { type: raw.type, sessionId: raw.sessionId };
    }
    case 'input': {
      if (!isText(raw.sessionId, MAX_ID) || !isText(raw.data, MAX_TEXT)) return null;
      return { type: 'input', sessionId: raw.sessionId, data: raw.data };
    }
    case 'answer': {
      if (!isText(raw.sessionId, MAX_ID) || !isText(raw.toolUseId, MAX_ID)) return null;
      const answers = parseAnswers(raw.answers);
      if (!answers) return null;
      return { type: 'answer', sessionId: raw.sessionId, toolUseId: raw.toolUseId, answers };
    }
    case 'ask': {
      if (!isText(raw.requestId, MAX_ID) || !isText(raw.text, MAX_TEXT) || !raw.text.trim()) return null;
      const size = parseOptionalSize(raw);
      if (!size) return null;
      return { type: 'ask', requestId: raw.requestId, text: raw.text, ...size.value };
    }
    case 'ask-cancel': {
      if (!isText(raw.requestId, MAX_ID)) return null;
      return { type: 'ask-cancel', requestId: raw.requestId };
    }
    case 'ask-start': {
      if (!isText(raw.requestId, MAX_ID) || !isText(raw.projectPath, MAX_PATH) || !isText(raw.prompt, MAX_TEXT)) return null;
      const size = parseOptionalSize(raw);
      if (!size) return null;
      return { type: 'ask-start', requestId: raw.requestId, projectPath: raw.projectPath, prompt: raw.prompt, ...size.value };
    }
    case 'list-projects':
      return { type: 'list-projects' };
    default:
      return null;
  }
}

/**
 * Question text → answer. Every value must be a string: an empty one is
 * allowed (a free-text answer left blank), a missing map or a non-string
 * value is not. At least one answer, or there is nothing to send to Claude.
 */
function parseAnswers(value: unknown): Answers | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > MAX_ANSWERS) return null;
  const answers: Answers = {};
  for (const [question, answer] of entries) {
    // `answers['__proto__'] = …` would set the prototype, not an answer.
    if (!question || question.length > MAX_TEXT || question === '__proto__') return null;
    if (typeof answer !== 'string' || answer.length > MAX_TEXT) return null;
    answers[question] = answer;
  }
  return answers;
}

/**
 * The optional size on `ask` and `ask-start`: both or neither, since half a
 * size can't size a PTY. Null when malformed; `value` is empty when absent.
 */
function parseOptionalSize(raw: Record<string, unknown>): { value: { cols?: number; rows?: number } } | null {
  if (raw.cols === undefined && raw.rows === undefined) return { value: {} };
  if (!isCells(raw.cols) || !isCells(raw.rows)) return null;
  return { value: { cols: raw.cols, rows: raw.rows } };
}

// ── Terminal frames ──

const encoder = new TextEncoder();
/** Fatal, so a frame with broken UTF-8 is refused rather than shown as replacement characters. */
const decoder = new TextDecoder('utf-8', { fatal: true });

/** `[u16 BE id length][id, UTF-8][output, UTF-8]`, as protocol.ts lays it out. */
export function encodeTerminalFrame(sessionId: string, data: string): Uint8Array {
  const id = encoder.encode(sessionId);
  if (id.length > MAX_FRAME_SESSION_ID_BYTES) throw new Error('session id too long for a terminal frame');
  const out = encoder.encode(data);
  const frame = new Uint8Array(2 + id.length + out.length);
  frame[0] = id.length >> 8;
  frame[1] = id.length & 0xff;
  frame.set(id, 2);
  frame.set(out, 2 + id.length);
  return frame;
}

/** Null for a frame too short for its header, an empty session id, or invalid UTF-8. */
export function decodeTerminalFrame(bytes: Uint8Array): { sessionId: string; data: string } | null {
  if (bytes.length < 2) return null;
  const idLength = (bytes[0] << 8) | bytes[1];
  if (idLength === 0 || bytes.length < 2 + idLength) return null;
  try {
    return {
      sessionId: decoder.decode(bytes.subarray(2, 2 + idLength)),
      data: decoder.decode(bytes.subarray(2 + idLength)),
    };
  } catch {
    return null;
  }
}

// ── The pairing QR code ──

const INVITE_PREFIX = 'switchboard://pair?';
const FINGERPRINT = /^[0-9a-f]{64}$/;
/** A DNS name or an IPv4 address; no brackets, so no IPv6 literals, which Bonjour names never are. */
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

export function encodeInvite(invite: PairingInvite): string {
  const query = new URLSearchParams({
    v: String(invite.protocol),
    fp: invite.fingerprint,
    code: invite.code,
    host: invite.host,
    port: String(invite.port),
  });
  return INVITE_PREFIX + query.toString();
}

/**
 * Null unless every part is there and well formed. The phone pins the
 * fingerprint it reads here, so a QR code with a short or mangled one must
 * fail now rather than produce a pin nothing can match.
 */
export function parseInvite(text: string): PairingInvite | null {
  if (typeof text !== 'string' || !text.startsWith(INVITE_PREFIX) || text.length > 2048) return null;
  const query = new URLSearchParams(text.slice(INVITE_PREFIX.length));
  for (const key of ['v', 'fp', 'code', 'host', 'port']) {
    if (query.getAll(key).length !== 1) return null;
  }
  const protocol = parseDecimal(query.get('v')!);
  const port = parseDecimal(query.get('port')!);
  const fingerprint = query.get('fp')!;
  const code = query.get('code')!;
  const host = query.get('host')!;
  if (protocol === null || !isProtocolNumber(protocol)) return null;
  if (port === null || port < 1 || port > 65535) return null;
  if (!FINGERPRINT.test(fingerprint)) return null;
  if (!code || code.length > MAX_CODE) return null;
  if (!HOST.test(host)) return null;
  return { protocol, fingerprint, code, host, port };
}

// ── Field checks ──

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-empty string of at most `max` characters. */
function isText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isProtocolNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 0xffff;
}

function isCells(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_TERMINAL_CELLS;
}

function parseDecimal(text: string): number | null {
  return /^[0-9]{1,5}$/.test(text) ? Number(text) : null;
}
