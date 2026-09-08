/**
 * The shape of a live PTY session inside the main process.
 *
 * This never crosses IPC — it holds a node-pty handle, timers and buffers — so
 * it lives here rather than in shared/types.ts. What the renderer gets to see
 * is assembled from it per message.
 */
import type * as pty from 'node-pty';
import type { RemoteConfig, RemoteStatusPayload } from '../shared/types.js';

/** Everything tracked about a session that is reached over ssh. */
export interface RemoteState {
  remote: RemoteConfig;
  /** "user@host" — the label shown on the connection card. */
  target: string;
  kind: string;
  shell?: string;
  shellExtraArgs?: string[];
  /** Which reconnect attempt we are on; reset once a link proves stable. */
  attempt: number;
  timer: NodeJS.Timeout | null;
  spawnedAt?: number;
  /** Set once the far end has said anything, which is what ends "connecting". */
  sawData?: boolean;
  everConnected?: boolean;
  /** The host rejected us — retrying would just fail the same way. */
  fatal?: boolean;
  /** Trailing output, kept so a fatal phrase split across chunks still matches. */
  tail?: string;
  /** The user asked to disconnect; nothing should redial. */
  userDisconnected?: boolean;
  status?: RemoteStatusPayload;
  cols?: number;
  rows?: number;
}

/** The MCP sidecar bound to a session, when one is running. */
export interface McpServerHandle {
  port: number;
  [key: string]: unknown;
}

export interface ActiveSession {
  pty: pty.IPty;
  rendererAttached: boolean;
  exited: boolean;
  /** Set once the record has been torn down; makes retirement idempotent. */
  retired?: boolean;
  /** Output held while no renderer is attached, replayed on reattach. */
  outputBuffer: string[];
  outputBufferSize: number;
  altScreen: boolean;
  projectPath: string;
  firstResize: boolean;
  projectFolder: string | null;
  /** Transcripts present at spawn; a new one appearing signals a fork. */
  knownJsonlFiles: Set<string> | null;
  sessionSlug: string | null;
  isPlainTerminal: boolean;
  /** The session id this one was forked from, while the fork is unresolved. */
  forkFrom: string | null;
  mcpServer: McpServerHandle | null;
  _openedAt: number;
  remote: RemoteState | null;
  /** The id Claude actually wrote, once a fork or plan-accept re-keys us. */
  realSessionId?: string;
  /** Every id this session has answered to, so a stale row can still stop it. */
  priorIds?: Set<string>;
  _killTimer?: NodeJS.Timeout | null;
  /** Set while a CLI turn is in flight, tracked off the OSC 0 title spinner. */
  _cliBusy?: boolean;
  /** The last OSC 0 title was the idle glyph — the other half of the above. */
  _oscIdle?: boolean;
  /** Drop output instead of buffering it, while a resize redraw is in flight. */
  _suppressBuffer?: boolean;
}

/** An active session known to be remote. The ssh helpers all require one. */
export type RemoteSession = ActiveSession & { remote: RemoteState };

export type ActiveSessionMap = Map<string, ActiveSession>;
