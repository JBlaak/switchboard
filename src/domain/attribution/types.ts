/**
 * Who changed a file.
 *
 * The Changes list groups a worktree's changed files by the session that
 * changed them, which is the thing a git panel cannot do. Git answers *what*
 * changed; these types carry the other half of the answer.
 *
 * A claim is exactly that — a claim. It comes from a `tool_use` in a
 * transcript, which records what the model *asked* to write, not what landed:
 * a rejected diff and a later revert both leave the claim behind. So nothing
 * here is a statement about the working tree, and the consumer intersects it
 * with `git status` before showing anything.
 */

/**
 * One session's claim on a path — a single file-modifying tool call.
 *
 * `atIso` is the transcript entry's own timestamp, so it is the moment the
 * model asked for the write. It is `''` on the entries that carry none, which
 * sorts them last rather than pretending to a time they never had.
 */
export interface EditClaim {
  sessionId: string;
  /** Absolute, resolved against the entry's own `cwd` when the tool gave a relative one. */
  path: string;
  atIso: string;
  /** The tool that asked: `Write`, `Edit`, `MultiEdit`, `NotebookEdit`. */
  tool: string;
}

/** Who touched a path, most recent first. */
export interface PathClaims {
  /** The absolute path the claims agree on. */
  path: string;
  sessions: SessionClaim[];
}

/**
 * One session's share of a path: when it last asked to write it, and how often.
 *
 * The count is of tool calls, not of surviving lines — two sessions on one file
 * is routine, and the count is what lets the UI say which of them did the bulk
 * of the work rather than only who was last.
 */
export interface SessionClaim {
  sessionId: string;
  lastAtIso: string;
  edits: number;
}
