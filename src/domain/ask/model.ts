/**
 * Asking Patch to start a session (#135): the user types what they want on the
 * empty screen, and Claude (Haiku, through the user's own `claude` CLI) picks
 * the project and turns the text into the session's first prompt.
 *
 * These are the shapes that cross the process boundary. The rules that build
 * the request and read the answer live next to them in this folder.
 */

/** One project Claude may route to, as the renderer knows it. */
export interface RouteCandidate {
  projectPath: string;
  /** The folder name the project is listed under. */
  folder: string;
  /** Titles of its most recent sessions, newest first. */
  recentTitles: string[];
}

export interface RouteRequest {
  /** Exactly what the user typed. */
  text: string;
  /** Local projects only: no remotes, no worktrees (R2). */
  candidates: RouteCandidate[];
}

/**
 * What came of a request.
 *
 * `prompt` is the session's whole `initialPrompt`, the request rewritten for
 * Claude (P1), ready to launch with. A `reason` is Patch's one line.
 */
export type RouteResult =
  | { kind: 'confident'; projectPath: string; prompt: string }
  /** Up to three candidate paths, best first. */
  | { kind: 'unsure'; candidates: string[]; prompt: string }
  | { kind: 'noMatch'; reason: string }
  /** The call failed, timed out or hit a usage limit. */
  | { kind: 'failed'; reason: string }
  | { kind: 'cancelled' };

// ── Quick Ask (#142) ──

/** Where a capture goes: BlaakTasks for a task, James for something to keep. */
export type CaptureTarget = 'tasks' | 'james';

/**
 * What came of a Quick Ask request: a routing result, or a capture (C1).
 *
 * A capture's `text` is the request without its command words ("create a task
 * to call Peter" → "call Peter"), otherwise word for word.
 */
export type QuickRouteResult = RouteResult | { kind: 'capture'; target: CaptureTarget; text: string };
