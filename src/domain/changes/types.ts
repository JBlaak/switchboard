/**
 * What changed, and who changed it, as one answer.
 *
 * Git says *what* changed and the transcripts say *who*, and the two are
 * composed in the main process rather than in the renderer: two round trips for
 * one list would let the halves disagree on screen — a file listed with no
 * claim because attribution was read a second later, or a claim for a file the
 * diff no longer reports. One channel, one answer, one moment in time.
 *
 * `claims` is a plain record rather than the `Map` the attribution service
 * hands back. A `Map` does not survive the trip through IPC in a shape the
 * renderer's types can rely on — the preload's contract is JSON-shaped data,
 * as every other payload crossing this boundary is. Keys are git's paths
 * exactly as `files` and `untracked` spell them (relative to the worktree,
 * forward-slashed), so a row can look up its own claims without re-deriving
 * anything. A path nothing claims is simply absent, and that absence is the
 * `Generated · not by a session` group the surface draws.
 */
import type { SessionClaim } from '../attribution/types';
import type { DiffResult } from '../git/types';

export interface ChangesPayload extends DiffResult {
  /** git's path → the sessions that claim it, most recent first. */
  claims: Record<string, SessionClaim[]>;
}
