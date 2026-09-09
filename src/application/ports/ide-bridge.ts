/**
 * The IDE the Claude CLI thinks it is talking to.
 *
 * Claude CLI discovers an editor over a local WebSocket and sends it diffs and
 * file opens instead of writing straight to disk. Switchboard answers that
 * protocol per session, which is what puts a proposed edit in the side panel
 * with accept/reject rather than in whatever editor happened to be running.
 *
 * One server per session: the CLI finds it through an environment variable, and
 * the sessions have to stay distinguishable.
 */

/** What the CLI needs in its environment to find the bridge. */
export interface IdeBridgeHandle {
  port: number;
  authToken: string;
}

/** How the user disposed of a diff the CLI asked us to show. */
export type DiffAction = 'accept' | 'accept-edited' | 'reject';

export interface IdeBridge {
  /**
   * Start a server for a session.
   *
   * Rejects rather than throwing into the launch path — a session whose bridge
   * fails to start still runs, just without the side panel.
   */
  start(sessionId: string, workspaceFolders: readonly string[]): Promise<IdeBridgeHandle>;

  stop(sessionId: string): void;
  stopAll(): void;

  /** Follow a session through a fork, so its bridge stays reachable. */
  rekey(oldSessionId: string, newSessionId: string): void;

  /** Hand the user's answer back to the CLI call that is parked on it. */
  resolveDiff(sessionId: string, diffId: string, action: DiffAction, editedContent: string | null): void;

  /**
   * Remove lock files a previous run left behind.
   *
   * The CLI finds editors by scanning a directory of lock files, so a crashed
   * run leaves a port advertised that nothing is listening on.
   */
  cleanStaleLocks(): void;
}
