/**
 * Keeping a remote session connected.
 *
 * A remote session outlives its SSH connection: the tmux session on the host
 * keeps running, so a dropped link is a transport problem to retry rather than
 * the end of the session. Everything here keeps one `session.remote` record in
 * step with that — which attempt we are on, whether the user asked to
 * disconnect, and what to tell the renderer so the UI isn't a black rectangle
 * while ssh works (or hangs).
 *
 * The policy — which failures are worth retrying, how long to wait, what to
 * call the reason — is in the domain. This is the part that acts on it.
 */
import {
  MAX_RETRIES, REMOTE_STABLE_MS, describeSshExit, isFatalSshOutput, isRetryableSshExit,
  outputProvesRemoteIsLive, remoteRetryDelay,
} from '../../domain/remote/reconnect-policy';
import { buildSshArgv, buildSshSpawn } from '../../domain/remote/ssh-command';
import type { RemoteStatusPayload } from '../../domain/remote/remote-status';
import type { ActiveSession, RemoteConnectionState } from '../model/active-session';
import type { SessionRegistry } from '../model/session-registry';
import type { Clock, Timers } from '../ports/clock';
import type { Logger } from '../ports/logger';
import type { RendererGateway } from '../ports/renderer-gateway';
import type { PtyHandle, TerminalGateway } from '../ports/terminal-gateway';
import type { RemoteObserver } from './session-lifecycle';

/** How much trailing output is kept, so a phrase split across chunks matches. */
const TAIL_KEEP_BYTES = 256;

/** The size a reconnect spawns at when the renderer has not reported one. */
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;

/**
 * What the supervisor needs back from the lifecycle.
 *
 * A reconnect produces a new PTY for an existing session record, and that PTY
 * has to be wired the same way the first one was.
 */
export interface SessionWiring {
  wire(sessionId: string, session: ActiveSession): void;
  retire(sessionId: string, session: ActiveSession, exitCode: number): void;
}

export interface RemoteSupervisorDeps {
  registry: SessionRegistry;
  terminals: TerminalGateway;
  renderer: RendererGateway;
  timers: Timers;
  clock: Clock;
  log: Logger;
  isWindows: boolean;
  /** Where a remote PTY is spawned from; the ssh process never uses it. */
  homeDir: string;
}

export class RemoteConnectionSupervisor implements RemoteObserver {
  #wiring: SessionWiring | null = null;

  constructor(private readonly deps: RemoteSupervisorDeps) {}

  /**
   * Complete the wiring loop.
   *
   * Called once by the composition root: the supervisor and the lifecycle each
   * need the other, and a setter is clearer than a lazily resolved dependency.
   */
  attach(wiring: SessionWiring): void {
    this.#wiring = wiring;
  }

  /** Dial the host, ready for the lifecycle to wire. */
  spawn(sessionId: string, state: RemoteConnectionState): PtyHandle {
    const { terminals, log, isWindows } = this.deps;
    const sshArgv = buildSshArgv(state.remote, sessionId, state.kind);
    const spawn = buildSshSpawn(sshArgv, {
      shell: state.shell,
      shellExtraArgs: state.shellExtraArgs,
      windows: isWindows,
    });
    log.info(`[remote] session=${sessionId} attempt=${state.attempt} ssh ${sshArgv.slice(0, -1).join(' ')} <tmux attach> via ${spawn.file}`);

    return terminals.spawn({
      file: spawn.file,
      args: spawn.args,
      // Reconnect at the size the renderer's terminal actually is, so tmux
      // repaints correctly instead of at the spawn default and then reflowing
      // once the first resize arrives.
      cols: state.cols || DEFAULT_COLS,
      rows: state.rows || DEFAULT_ROWS,
      cwd: this.deps.homeDir,
      env: { ...terminals.baseEnv, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });
  }

  /**
   * Watch a remote session's output for the two things it can tell us.
   *
   * Output from the far end is what ends the "connecting" state — an auth
   * prompt, a login banner, tmux repainting. ssh's own transport errors are
   * excluded: they arrive on the same PTY but mean the opposite, and counting
   * them as a connect made the card vanish and come back.
   *
   * Output is also where a permanently broken connection announces itself, and
   * the phrase can straddle two chunks, so a short tail is kept.
   */
  observeOutput(sessionId: string, session: ActiveSession, data: string): void {
    const state = session.remote;
    if (!state) return;

    if (!state.fatal) {
      const recent = state.tail + data;
      if (isFatalSshOutput(recent)) state.fatal = true;
      state.tail = recent.slice(-TAIL_KEEP_BYTES);
    }

    if (!state.sawData && outputProvesRemoteIsLive(data)) {
      state.sawData = true;
      state.everConnected = true;
      this.sendStatus(sessionId, { phase: 'connected', target: state.target });
    }
  }

  /** Decide what a dead ssh means; true when a reconnect is scheduled. */
  handleExit(sessionId: string, session: ActiveSession, exitCode: number, signal?: number): boolean {
    const state = session.remote;
    if (!state) return false;

    const lasted = this.deps.clock.now() - state.spawnedAt;
    // signal and sawData are both logged because they are what distinguishes
    // the failure modes after the fact: a killed ssh from a clean exit, and a
    // host that never spoke from one that did.
    this.deps.log.info(
      `[remote] session=${sessionId} ssh exited code=${exitCode} signal=${signal || 'none'} ` +
      `after=${Math.round(lasted / 1000)}s attempt=${state.attempt} sawData=${state.sawData} ` +
      `fatal=${state.fatal} byUser=${state.userDisconnected}`);

    if (state.userDisconnected) {
      this.sendStatus(sessionId, { phase: 'disconnected', target: state.target });
      return false;
    }
    if (state.fatal) {
      this.sendStatus(sessionId, {
        phase: 'failed', target: state.target, reason: 'the host rejected the connection',
      });
      return false;
    }
    // Exit 0 (left the shell, detached tmux) and the tmux-missing bail-out are
    // answers, not transport failures — reconnecting would fight the user.
    if (!isRetryableSshExit(exitCode, signal)) {
      this.sendStatus(sessionId, {
        phase: 'disconnected', target: state.target, reason: describeSshExit(exitCode, signal),
      });
      return false;
    }
    // A link that stood up for a while was genuinely working, so the next break
    // starts the backoff over rather than inheriting the previous attempt count.
    if (lasted >= REMOTE_STABLE_MS) state.attempt = 0;

    return this.#scheduleReconnect(sessionId, state, describeSshExit(exitCode, signal));
  }

  /**
   * Dial again now, cancelling any pending backoff.
   *
   * Also the "the user clicked the session, they want it back" path, which
   * shouldn't wait out the timer. Safe to call at any time: it no-ops unless
   * the session is remote, still held, and actually between connections.
   */
  redialNow(sessionId: string): void {
    const { registry, timers, clock, log } = this.deps;
    const session = registry.get(sessionId);
    const state = session?.remote;
    if (!session || !state) return;

    timers.clearTimeout(state.timer);
    state.timer = null;
    if (state.userDisconnected || !session.exited) return;

    let pty: PtyHandle;
    try {
      pty = this.spawn(sessionId, state);
    } catch (err) {
      log.error(`[remote] session=${sessionId} respawn failed: ${(err as Error).message}`);
      this.#scheduleReconnect(sessionId, state, (err as Error).message);
      return;
    }

    session.pty = pty;
    session.exited = false;
    session.firstResize = true;
    state.spawnedAt = clock.now();
    state.sawData = false;
    state.tail = '';

    this.sendStatus(sessionId, {
      phase: 'connecting', target: state.target,
      attempt: state.attempt, maxAttempts: MAX_RETRIES,
    });
    this.#wiring?.wire(sessionId, session);
  }

  /**
   * An explicit "retry now" from the user.
   *
   * Starts the backoff ladder over: the user knows something changed (VPN up,
   * host awake) that the previous attempts did not.
   */
  retryNow(sessionId: string): { ok: boolean; error?: string; alreadyConnected?: boolean } {
    const session = this.deps.registry.get(sessionId);
    if (!session?.remote) return { ok: false, error: 'not a remote session' };
    if (session.remote.userDisconnected) return { ok: false, error: 'disconnected' };
    if (!session.exited) return { ok: true, alreadyConnected: true };
    session.remote.attempt = 0;
    this.redialNow(sessionId);
    return { ok: true };
  }

  /**
   * The user asked to stop, so stop trying.
   *
   * Marked on the record rather than just clearing the timer, because the PTY's
   * own exit runs afterwards and would otherwise read as a drop worth retrying.
   */
  markDisconnected(session: ActiveSession): void {
    const state = session.remote;
    if (!state) return;
    state.userDisconnected = true;
    this.deps.timers.clearTimeout(state.timer);
    state.timer = null;
  }

  /**
   * Remember a status and send it.
   *
   * Remembered so a renderer that reloads (or reattaches) can be told where the
   * connection stands instead of inferring it from an empty screen.
   */
  sendStatus(sessionId: string, status: RemoteStatusPayload): void {
    const session = this.deps.registry.get(sessionId);
    if (session?.remote) session.remote.status = status;
    this.deps.renderer.remoteStatus(sessionId, status);
  }

  /** Re-send the last known status, for a renderer that just reattached. */
  resendStatus(sessionId: string, session: ActiveSession): void {
    if (session.remote?.status) this.deps.renderer.remoteStatus(sessionId, session.remote.status);
  }

  #scheduleReconnect(sessionId: string, state: RemoteConnectionState, reason: string): boolean {
    const { timers, log } = this.deps;
    state.attempt += 1;

    if (state.attempt > MAX_RETRIES) {
      log.warn(`[remote] session=${sessionId} giving up after ${MAX_RETRIES} attempts`);
      this.sendStatus(sessionId, {
        phase: 'failed', target: state.target, reason,
        attempts: MAX_RETRIES, everConnected: state.everConnected,
      });
      return false;
    }

    const delayMs = remoteRetryDelay(state.attempt);
    this.sendStatus(sessionId, {
      phase: 'retrying', target: state.target, reason,
      attempt: state.attempt, maxAttempts: MAX_RETRIES, delayMs,
      everConnected: state.everConnected,
    });

    timers.clearTimeout(state.timer);
    state.timer = timers.setTimeout(() => {
      state.timer = null;
      this.redialNow(sessionId);
    }, delayMs);
    return true;
  }
}
