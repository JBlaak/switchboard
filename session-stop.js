/**
 * Ending a PTY session.
 *
 * Retiring a session used to be the sole privilege of its PTY's exit event, so
 * anything that killed a process without that event arriving left the record
 * behind with `exited` false — a row stuck on "Running" that the stop button
 * could only re-signal, never clear. Every path that ends a session now goes
 * through these helpers, and the last of them retires the record whether or not
 * the process cooperated.
 *
 * Call init(ctx) once with shared context.
 */

let activeSessions, getMainWindow, log, shutdownMcpServer, kill, timers;

function init(ctx) {
  activeSessions = ctx.activeSessions;
  getMainWindow = ctx.getMainWindow;
  log = ctx.log;
  shutdownMcpServer = ctx.shutdownMcpServer;
  // Seams for tests — a fake kernel and a fake clock. Nothing else passes them.
  kill = ctx.kill || ((pid, signal) => process.kill(pid, signal));
  timers = ctx.timers || { setTimeout, clearTimeout };
}

// SIGTERM, then SIGKILL, then give up and retire anyway.
const STOP_ESCALATE_MS = 3000;
const STOP_GIVE_UP_MS = 3000;

/** Is the PTY's process still there? A zombie awaiting reap still answers, so
 *  this only reads false once the process is genuinely gone. */
function isPtyAlive(session) {
  const pid = session.pty && session.pty.pid;
  if (!pid) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but isn't ours to signal — still alive.
    return err.code === 'EPERM';
  }
}

/** Signal the whole process tree, not just the shell.
 *  node-pty's own kill() signals a single pid (unixTerminal.js: `process.kill(this.pid, …)`),
 *  but sessions are spawned as `zsh -l -i -c 'claude …'` and a preLaunchCmd
 *  ("aws-vault exec … --") puts another process in between. forkpty() calls
 *  setsid() in the child, so its pid doubles as its process-group id and a
 *  negative pid reaches everything under it — which is what stops `claude`
 *  outliving the row that owns it. */
function signalSessionTree(session, signal) {
  const pid = session.pty && session.pty.pid;
  if (!pid) return false;
  try {
    kill(-pid, signal);
    return true;
  } catch {}
  // No process group to signal (Windows, or the leader is already reaped) —
  // fall back to node-pty, which on Windows kills the job object anyway.
  try {
    session.pty.kill(signal);
    return true;
  } catch {}
  return false;
}

/** Tear down a session's record and tell the renderer it's over. Idempotent:
 *  the exit event and the escalation timer both call it, and whichever arrives
 *  first wins. */
function retireSession(sessionId, session, exitCode) {
  if (session.retired) return;
  session.retired = true;
  session.exited = true;
  timers.clearTimeout(session._killTimer);
  session._killTimer = null;

  const realId = session.realSessionId || sessionId;
  shutdownMcpServer(realId);
  session.mcpServer = null;

  const mainWindow = getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('process-exited', realId, exitCode);
    // If a fork/plan-accept transition re-keyed this session under realId but
    // the PTY exited before transition detection ran, also notify the renderer
    // for the original sessionId so it doesn't stay stuck as "Running".
    if (realId !== sessionId && activeSessions.has(sessionId)) {
      mainWindow.webContents.send('process-exited', sessionId, exitCode);
    }
    // Same for every id this session has been re-keyed away from — a row opened
    // before the transition is still displaying one of them.
    if (session.priorIds) {
      for (const priorId of session.priorIds) {
        if (priorId === realId || priorId === sessionId) continue;
        mainWindow.webContents.send('process-exited', priorId, exitCode);
      }
    }
  }
  activeSessions.delete(realId);
  // Clean up the original key too in case transition detection hasn't run yet
  activeSessions.delete(sessionId);
}

/** Ask a session to stop, and make sure it does. */
function stopSessionTree(sessionId, session) {
  const pty = session.pty;
  signalSessionTree(session, 'SIGTERM');

  timers.clearTimeout(session._killTimer);
  session._killTimer = timers.setTimeout(() => {
    // A remote session that dropped and redialled has a different PTY by now;
    // killing that one would take down a connection nobody asked to stop.
    if (session.retired || session.pty !== pty) return;
    log.warn(`[stop] session=${sessionId} alive ${STOP_ESCALATE_MS}ms after SIGTERM — escalating to SIGKILL`);
    signalSessionTree(session, 'SIGKILL');

    session._killTimer = timers.setTimeout(() => {
      if (session.retired || session.pty !== pty) return;
      log.warn(`[stop] session=${sessionId} survived SIGKILL — retiring the record anyway`);
      retireSession(sessionId, session, -1);
    }, STOP_GIVE_UP_MS);
  }, STOP_ESCALATE_MS);
}

/** Look up an active session by any id it has answered to. A fork or
 *  plan-accept re-keys the map (see session-transitions.js), so a sidebar row
 *  opened before the transition still carries the old id — and a stop aimed at
 *  that id used to report "not running" while the PTY kept going. */
function findActiveSession(sessionId) {
  const direct = activeSessions.get(sessionId);
  if (direct) return { key: sessionId, session: direct };
  for (const [key, session] of activeSessions) {
    if (session.priorIds && session.priorIds.has(sessionId)) return { key, session };
  }
  return null;
}

module.exports = {
  init, isPtyAlive, signalSessionTree, retireSession, stopSessionTree, findActiveSession,
  STOP_ESCALATE_MS, STOP_GIVE_UP_MS,
};
