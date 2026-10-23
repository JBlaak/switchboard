/**
 * The wire protocol between Switchboard and the Android app (Phone access, #194).
 *
 * One WebSocket per phone, over a TLS 1.3 listener on the Mac's LAN interfaces.
 * Both ends present a self-signed certificate and each pins the other's
 * SHA-256 fingerprint: the phone learned the Mac's from the pairing QR code,
 * the Mac learned the phone's from the TLS connection the pairing ran over.
 * Nothing in this file is about trust; by the time a message is read, the
 * listener has already decided who is on the other end.
 *
 * Text frames carry one JSON object each, with a `type`. Binary frames carry
 * terminal output only (see `encodeTerminalFrame`). This file is the source of
 * truth for both sides: the Kotlin models in `android/` mirror these shapes
 * field for field, so change them together and bump PROTOCOL_VERSION when an
 * old app could misread a new message.
 */
import type { Answers, PendingQuestions, QuestionsOutcome } from '../questions/question';

/**
 * Bumped whenever a message changes shape in a way an older peer would misread.
 * Adding an optional field or a new message type the other side may ignore
 * does not need a bump.
 */
export const PROTOCOL_VERSION = 1;

/** The Bonjour service type the Mac advertises. */
export const BONJOUR_SERVICE_TYPE = '_switchboard._tcp';

/** WebSocket close codes the app turns into a screen of its own. */
export const CLOSE = {
  /** A malformed or unexpected message. */
  protocolError: 4000,
  /** The versions differ; the app shows "Update the app". */
  updateRequired: 4001,
  /** The device is not (or no longer) enrolled; the app shows "No longer paired". */
  notPaired: 4003,
  /** Phone access was turned off on the Mac. */
  turnedOff: 4004,
  /** A pairing attempt ended (accepted, declined, expired); the app reconnects as paired or not. */
  pairingOver: 4005,
} as const;

// ── Shared shapes ──

/**
 * Who a session's terminal is sized for (#194: one active device per session).
 * The phone compares `deviceId` with its own to tell "here" from "another phone".
 */
export type TerminalOwner =
  | { kind: 'mac' }
  | { kind: 'device'; deviceId: string; name: string };

/** A running session as the phone lists it, in the sidebar's order. */
export interface PhoneSession {
  /** The session's current id; follows re-keys (see `session-rekeyed`). */
  id: string;
  /** The name the sidebar shows. */
  name: string;
  /** The project's folder name, e.g. "switchboard". */
  project: string;
  projectPath: string;
  /** "user@host" for an SSH session, else null. */
  remote: string | null;
  /** busy: a turn is running; needs-you: blocked on the user; idle: waiting for a prompt. */
  state: 'busy' | 'idle' | 'needs-you';
  /** Why it needs you, when it does: questions the app can answer, or something in the terminal. */
  waiting: 'questions' | 'terminal' | null;
  owner: TerminalOwner;
  /** Epoch ms of the last state change, for the row's "2m". */
  changedAt: number;
}

/** A local project Ask Patch may start a session in. */
export interface PhoneProject {
  path: string;
  /** The folder name it is listed under. */
  folder: string;
  /** Sessions running in it right now. */
  running: number;
}

/** What came of an Ask Patch request, as the phone needs it. */
export type PhoneAskResult =
  | { kind: 'confident'; sessionId: string; project: string }
  /** Up to three, best first, each with its most recent session title. */
  | { kind: 'unsure'; candidates: { path: string; folder: string; recentTitle: string | null }[]; prompt: string }
  /** Patch's one line; the phone shows the project list next. */
  | { kind: 'noMatch'; reason: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'cancelled' };

/** Why a pairing attempt was turned away. */
export type PairRejection = 'expired' | 'wrong-code' | 'locked-out' | 'declined' | 'not-pairing';

// ── Phone → Mac ──

export type ClientMessage =
  /** First message on every connection. */
  | { type: 'hello'; protocol: number; appVersion: string }
  /** Only on a pairing connection (an unenrolled certificate while a code is live). */
  | { type: 'pair'; code: string; deviceName: string }
  /** Start streaming a session: replay, then live output. Reports this device's size for it. */
  | { type: 'attach'; sessionId: string; cols: number; rows: number }
  | { type: 'detach'; sessionId: string }
  /** This device's terminal size for a session changed. Applied only while this device owns it. */
  | { type: 'size'; sessionId: string; cols: number; rows: number }
  /** Make this device the active one for the session (Use here). */
  | { type: 'use-here'; sessionId: string }
  /** Bytes for the PTY: prompt-box text or a key bar key. Dropped unless this device owns the session. */
  | { type: 'input'; sessionId: string; data: string }
  /** Answering also makes this device the active one. */
  | { type: 'answer'; sessionId: string; toolUseId: string; answers: Answers }
  /** Ask Patch: route `text` to a project. One request per device at a time. */
  | { type: 'ask'; requestId: string; text: string }
  | { type: 'ask-cancel'; requestId: string }
  /** Start the session in a project the user picked; `prompt` is Patch's (unsure) or the typed text (no match). */
  | { type: 'ask-start'; requestId: string; projectPath: string; prompt: string }
  | { type: 'list-projects' };

// ── Mac → Phone ──

export type ServerMessage =
  /** The answer to `hello` on an enrolled connection; the full state follows. */
  | { type: 'welcome'; protocol: number; macName: string; deviceId: string }
  /** The answer to `hello` on a pairing connection. */
  | { type: 'pairing'; protocol: number; macName: string }
  /** The code was right; the Mac is showing the confirm dialog. */
  | { type: 'pair-pending' }
  /** Confirmed on the Mac; reconnect, and this certificate is now enrolled. Followed by close(pairingOver). */
  | { type: 'pair-accepted'; deviceId: string }
  | { type: 'pair-rejected'; reason: PairRejection }
  /** Sent instead of `welcome` before close(updateRequired). */
  | { type: 'update-required'; protocol: number; macVersion: string }
  /** The whole running list, sent on welcome and on every change. */
  | { type: 'sessions'; sessions: PhoneSession[] }
  /** A fork or plan-accept gave a session a new id; move the row and any open view. */
  | { type: 'session-rekeyed'; from: string; to: string }
  /** Sent before the replay frames of an attach. */
  | { type: 'attached'; sessionId: string; owner: TerminalOwner }
  | { type: 'owner'; sessionId: string; owner: TerminalOwner }
  /** The session's process ended. */
  | { type: 'exited'; sessionId: string; exitCode: number }
  /** Every pending question set, on welcome and on every change. */
  | { type: 'questions'; pending: PendingQuestions[] }
  | { type: 'questions-settled'; sessionId: string; toolUseId: string; outcome: QuestionsOutcome; answeredOn: 'mac' | 'phone' | null }
  | { type: 'answer-result'; sessionId: string; toolUseId: string; ok: boolean; error?: string }
  | { type: 'ask-result'; requestId: string; result: PhoneAskResult }
  | { type: 'ask-started'; requestId: string; sessionId: string }
  | { type: 'ask-error'; requestId: string; error: string }
  | { type: 'projects'; projects: PhoneProject[] }
  /** Sent before close(notPaired) when the device is revoked or the Mac's identity is reset. */
  | { type: 'revoked' };

// ── Terminal frames ──
//
// A binary frame is one chunk of a session's output:
//
//   [u16 big-endian: byte length of the session id][session id, UTF-8][output, UTF-8]
//
// The output is the same text the renderer's terminal is fed, so the phone's
// xterm.js writes it as is. Replay on attach is sent as one or more of these
// after `attached`, then live output follows in the same form.

// ── The pairing QR code ──
//
// Encoded as `switchboard://pair?v=<protocol>&fp=<fingerprint>&code=<code>&host=<host>&port=<port>`.

/** What the QR code on the Mac holds. */
export interface PairingInvite {
  protocol: number;
  /** The Mac's certificate fingerprint, lowercase hex SHA-256 without separators. */
  fingerprint: string;
  /** The one-time pairing code. */
  code: string;
  /** The Bonjour host name, e.g. "joris-mbp.local"; a hint, the fingerprint is what counts. */
  host: string;
  port: number;
}
