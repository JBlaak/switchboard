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
