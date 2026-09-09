/**
 * A session from its first byte to its last.
 *
 * Three jobs live here because they are one story. Wiring a PTY turns its byte
 * stream into the events the UI renders from. Retiring a session tears the
 * record down and tells every id it ever answered to. Stopping one makes sure
 * it actually stops.
 *
 * Retiring used to be the sole privilege of the PTY's exit event, so anything
 * that killed a process without that event arriving left the record behind with
 * `exited` false — a row stuck on "Running" that the stop button could only
 * re-signal, never clear. Every path that ends a session now goes through
 * `retire`, and the last step of an escalation retires the record whether or
 * not the process cooperated.
 */
import { ENTER_ALT_SCREEN, HIDE_CURSOR } from '../../domain/terminal/ansi';
import { parseTerminalEvents } from '../../domain/terminal/osc';
import type { ActiveSession } from '../model/active-session';
import type { SessionRegistry } from '../model/session-registry';
import type { Timers } from '../ports/clock';
import type { IdeBridge } from '../ports/ide-bridge';
import type { Logger } from '../ports/logger';
import type { RendererGateway } from '../ports/renderer-gateway';
import type { TerminalGateway } from '../ports/terminal-gateway';

/** SIGTERM, then SIGKILL, then give up and retire anyway. */
export const STOP_ESCALATE_MS = 3000;
export const STOP_GIVE_UP_MS = 3000;

/**
 * The remote half of the lifecycle, which only remote sessions reach.
 *
 * An interface rather than a direct dependency because the supervisor needs the
 * lifecycle back — it re-wires a freshly dialled PTY to the same session record.
 */
export interface RemoteObserver {
  /** Watch a remote session's output for the two things it can tell us. */
  observeOutput(sessionId: string, session: ActiveSession, data: string): void;
  /**
   * Decide what a dead ssh means.
   *
   * True when the session lives on (a reconnect is scheduled) and false when
   * the caller should run the normal exit teardown.
   */
  handleExit(sessionId: string, session: ActiveSession, exitCode: number, signal?: number): boolean;
  /** Stop redialling, because the user asked to. */
  markDisconnected(session: ActiveSession): void;
}

export interface SessionLifecycleDeps {
  registry: SessionRegistry;
  terminals: TerminalGateway;
  renderer: RendererGateway;
  ideBridge: IdeBridge;
  remote: RemoteObserver;
  timers: Timers;
  log: Logger;
}

export class SessionLifecycle {
  constructor(private readonly deps: SessionLifecycleDeps) {}

  /**
   * Turn a PTY's stream into events, and its exit into a decision.
   *
   * Called again on every remote reconnect: a remote session re-spawns its PTY
   * and has to rewire the fresh one to the same session record.
   */
  wire(sessionId: string, session: ActiveSession): void {
    const { renderer, remote, log } = this.deps;
    const pty = session.pty;

    pty.onData((data: string) => {
      // A fork or plan-accept may have re-keyed this session since it started;
      // the renderer knows it under the new id.
      const currentId = session.realSessionId || sessionId;

      if (session.remote) remote.observeOutput(sessionId, session, data);

      for (const event of parseTerminalEvents(data)) {
        switch (event.kind) {
          case 'title':
          case 'progress': {
            const busy = session.cliBusy.observe(event);
            if (busy !== null) renderer.cliBusyState(currentId, busy);
            break;
          }
          case 'notification':
            log.info(`[osc9] session=${currentId} message="${event.message}"`);
            renderer.terminalNotification(currentId, event.message);
            break;
          case 'alt-screen':
            session.altScreen = event.active;
            log.debug(`[altscreen] session=${currentId} ${event.active ? 'ON' : 'OFF'}`);
            break;
          case 'bell':
            log.debug(`[bel] session=${currentId}`);
            break;
        }
      }

      session.output.append(data);
      renderer.terminalData(currentId, data);
    });

    pty.onExit(({ exitCode, signal }) => {
      session.exited = true;

      // A remote session's PTY is one SSH connection, not the session itself —
      // the work lives in tmux on the far end. If the link can come back, keep
      // the session (and the renderer's terminal) alive and dial again.
      if (session.remote && remote.handleExit(sessionId, session, exitCode, signal)) return;

      this.retire(sessionId, session, exitCode);
    });
  }

  /**
   * Replay what a reattaching renderer missed.
   *
   * Order matters: the alternate-screen switch first, so a TUI's repaint lands
   * in the right buffer, then the buffered output, then the cursor hidden — the
   * live stream or the resize nudge re-shows it at the correct position, which
   * avoids a stale cursor sitting wherever the replay ended.
   */
  replayTo(sessionId: string, session: ActiveSession): void {
    const { renderer } = this.deps;
    if (session.altScreen && !session.isPlainTerminal) {
      renderer.terminalData(sessionId, ENTER_ALT_SCREEN);
    }
    for (const chunk of session.output.chunks()) {
      renderer.terminalData(sessionId, chunk);
    }
    if (!session.isPlainTerminal) renderer.terminalData(sessionId, HIDE_CURSOR);
  }

  /**
   * Tear a session's record down and tell the renderer it is over.
   *
   * Idempotent: the exit event and the escalation timer both call it, and
   * whichever arrives first wins.
   */
  retire(sessionId: string, session: ActiveSession, exitCode: number): void {
    if (session.retired) return;
    session.retired = true;
    session.exited = true;

    const { registry, renderer, ideBridge, timers } = this.deps;
    timers.clearTimeout(session.killTimer);
    session.killTimer = null;

    const realId = session.realSessionId || sessionId;
    ideBridge.stop(realId);
    session.ideBridge = null;

    renderer.processExited(realId, exitCode);

    // If a fork or plan-accept re-keyed this session under realId but the PTY
    // exited before the transition was detected, the original key may still be
    // in the registry — and a row is still displaying it.
    if (realId !== sessionId && registry.has(sessionId)) {
      renderer.processExited(sessionId, exitCode);
    }

    // And every id it has been re-keyed away from: a row opened before the
    // transition is still displaying one of those, and would otherwise stay
    // stuck on "Running". These are no longer in the registry by definition,
    // so there is nothing to check them against.
    for (const priorId of session.priorIds ?? []) {
      if (priorId === realId || priorId === sessionId) continue;
      renderer.processExited(priorId, exitCode);
    }

    registry.delete(realId);
    // The original key too, in case transition detection has not run yet.
    registry.delete(sessionId);
  }

  /** Ask a session to stop, and make sure it does. */
  stop(sessionId: string, session: ActiveSession): void {
    const { terminals, timers, log } = this.deps;
    const pty = session.pty;

    terminals.signalTree(session.pty, 'SIGTERM');

    timers.clearTimeout(session.killTimer);
    session.killTimer = timers.setTimeout(() => {
      // A remote session that dropped and redialled has a different PTY by now;
      // killing that one would take down a connection nobody asked to stop.
      if (session.retired || session.pty !== pty) return;
      log.warn(`[stop] session=${sessionId} alive ${STOP_ESCALATE_MS}ms after SIGTERM — escalating to SIGKILL`);
      terminals.signalTree(session.pty, 'SIGKILL');

      session.killTimer = timers.setTimeout(() => {
        if (session.retired || session.pty !== pty) return;
        log.warn(`[stop] session=${sessionId} survived SIGKILL — retiring the record anyway`);
        this.retire(sessionId, session, -1);
      }, STOP_GIVE_UP_MS);
    }, STOP_ESCALATE_MS);
  }

  /**
   * The ids with something running under them.
   *
   * Also where a stuck row heals itself: `exited` is only ever set from the
   * PTY's exit event, so a process that died without one would keep its row
   * green for the life of the app. The pid is the ground truth, and checking it
   * here means the next poll clears the row instead of needing a restart.
   */
  runningSessionIds(): string[] {
    const { registry, terminals, log } = this.deps;
    const running: string[] = [];
    for (const [sessionId, session] of registry.snapshot()) {
      if (session.isReconnecting) { running.push(sessionId); continue; }
      if (session.exited) continue;
      if (!terminals.isAlive(session.pty)) {
        log.warn(`[active] session=${sessionId} pid=${session.pty.pid} gone with no exit event — retiring`);
        this.retire(sessionId, session, -1);
        continue;
      }
      running.push(sessionId);
    }
    return running;
  }

  /** Signal every session on the way out, so nothing is left orphaned. */
  terminateAll(): void {
    const { registry, terminals, remote } = this.deps;
    for (const [sessionId, session] of registry.snapshot()) {
      remote.markDisconnected(session);
      // SIGTERM to the group rather than SIGHUP to the shell: the shell is only
      // a wrapper, and the `claude` underneath it would otherwise be orphaned.
      if (!session.exited) terminals.signalTree(session.pty, 'SIGTERM');
      registry.delete(sessionId);
    }
  }
}
