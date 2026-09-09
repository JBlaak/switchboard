/**
 * A session that is actually running.
 *
 * The counterpart to the stored `Session`: that one is a transcript on disk,
 * this one is a live process with a screen, a buffer of output nobody has read
 * yet, and — for a remote session — a connection that keeps breaking. It never
 * crosses the IPC boundary; what the renderer sees is assembled from it per
 * message.
 */
import { CliBusyTracker } from '../../domain/terminal/osc';
import { OutputBuffer } from '../../domain/terminal/output-buffer';
import type { RemoteConfig } from '../../domain/project/remote-target';
import type { RemoteStatusPayload } from '../../domain/remote/remote-status';
import type { IdeBridgeHandle } from '../ports/ide-bridge';
import type { PtyHandle } from '../ports/terminal-gateway';
import type { TimerHandle } from '../ports/clock';

/**
 * Everything tracked about a session reached over ssh.
 *
 * A remote session outlives its SSH connection: the tmux session on the host
 * keeps running, so a dropped link is a transport problem to retry rather than
 * the end of the session. This is the state that keeps the retry ladder, the
 * user's intent and the UI's picture of it in step.
 */
export interface RemoteConnectionState {
  remote: RemoteConfig;
  /** "user@host" — the label shown on the connection card. */
  target: string;
  kind: string;
  shell?: string;
  shellExtraArgs?: string[];
  /** Which reconnect attempt we are on; reset once a link proves stable. */
  attempt: number;
  timer: TimerHandle | null;
  spawnedAt: number;
  /** Set once the far end has said anything, which is what ends "connecting". */
  sawData: boolean;
  everConnected: boolean;
  /** The host rejected us — retrying would just fail the same way. */
  fatal: boolean;
  /** Trailing output, kept so a fatal phrase split across chunks still matches. */
  tail: string;
  /** The user asked to disconnect; nothing should redial. */
  userDisconnected: boolean;
  /** The last status sent, so a reloaded renderer can be told where we stand. */
  status?: RemoteStatusPayload;
  cols?: number;
  rows?: number;
}

export interface ActiveSessionSpec {
  pty: PtyHandle;
  projectPath: string;
  projectFolder: string | null;
  /** Transcripts present at spawn; a new one appearing signals a fork. */
  knownTranscriptIds: Set<string> | null;
  sessionSlug: string | null;
  isPlainTerminal: boolean;
  /** The session id this one was forked from, while the fork is unresolved. */
  forkFrom: string | null;
  ideBridge: IdeBridgeHandle | null;
  remote: RemoteConnectionState | null;
  openedAt: number;
  maxBufferBytes?: number;
}

export class ActiveSession {
  pty: PtyHandle;
  readonly output: OutputBuffer;
  /** Whether a CLI turn is in flight, tracked off the OSC 0 title. */
  readonly cliBusy = new CliBusyTracker();

  rendererAttached = true;
  exited = false;
  /** Set once the record has been torn down; makes retirement idempotent. */
  retired = false;
  /** True while the process has switched to the alternate screen buffer. */
  altScreen = false;
  /** The next resize should nudge the size, to force a TUI repaint. */
  firstResize = true;

  readonly projectPath: string;
  readonly projectFolder: string | null;
  knownTranscriptIds: Set<string> | null;
  sessionSlug: string | null;
  readonly isPlainTerminal: boolean;
  readonly forkFrom: string | null;
  ideBridge: IdeBridgeHandle | null;
  readonly openedAt: number;
  remote: RemoteConnectionState | null;

  /** The id Claude actually wrote, once a fork or plan-accept re-keys us. */
  realSessionId?: string;
  /** Every id this session has answered to, so a stale row can still stop it. */
  priorIds?: Set<string>;
  /** The pending step of a stop escalation. */
  killTimer: TimerHandle | null = null;

  constructor(spec: ActiveSessionSpec) {
    this.pty = spec.pty;
    this.output = new OutputBuffer(spec.maxBufferBytes);
    this.projectPath = spec.projectPath;
    this.projectFolder = spec.projectFolder;
    this.knownTranscriptIds = spec.knownTranscriptIds;
    this.sessionSlug = spec.sessionSlug;
    this.isPlainTerminal = spec.isPlainTerminal;
    this.forkFrom = spec.forkFrom;
    this.ideBridge = spec.ideBridge;
    this.remote = spec.remote;
    this.openedAt = spec.openedAt;
  }

  /** True when this session is reached over ssh. */
  get isRemote(): boolean {
    return this.remote !== null;
  }

  /**
   * True while the session is between connections rather than gone.
   *
   * A remote session waiting out its backoff is still live — the tmux session
   * is running and a reconnect is on a timer — so reporting it stopped would
   * blank its sidebar dot and stop the renderer restoring it after a reload.
   */
  get isReconnecting(): boolean {
    return !!(this.remote && this.remote.timer && !this.remote.userDisconnected);
  }

  /** Clicking a disconnected remote session is an ask for the connection back. */
  get wantsRedial(): boolean {
    return !!(this.remote && this.exited && !this.remote.userDisconnected);
  }

  /** Every id a renderer might still be displaying this session under. */
  allIds(currentKey: string): string[] {
    const ids = new Set<string>([currentKey]);
    if (this.realSessionId) ids.add(this.realSessionId);
    for (const prior of this.priorIds ?? []) ids.add(prior);
    return [...ids];
  }
}
