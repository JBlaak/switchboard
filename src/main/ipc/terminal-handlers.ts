/**
 * The terminal stream: opening a session, and the keystrokes and resizes that
 * follow.
 *
 * Input and resize are fire-and-forget by design — they happen per keystroke
 * and per drag frame, and an invoke round-trip per character would be felt.
 */
import { INVOKE, SEND } from '../../ipc/channels';
import type { SessionOptions } from '../../domain/launch/session-options';
import type { Container } from '../composition-root';
import type { IpcRegistrar } from './registrar';

/**
 * How long buffering stays suppressed after a plain terminal's resize.
 *
 * Long enough for the shell to finish repainting its prompt, so the redraw does
 * not end up in the replay a later reattach sees.
 */
const RESIZE_SETTLE_MS = 200;

/** The delays of the resize nudge that forces a TUI to repaint on reattach. */
const NUDGE_DELAY_MS = 50;

export function registerTerminalHandlers(ipc: IpcRegistrar, app: Container): void {
  ipc.handle(INVOKE.openTerminal, (
    sessionId: string,
    projectPath: string,
    isNew: boolean,
    options?: SessionOptions,
  ) => {
    if (!app.renderer.attached) return { ok: false, error: 'no window' };
    return app.launcher.open({ sessionId, projectPath, isNew, options });
  });

  ipc.on(SEND.terminalInput, (sessionId: string, data: string) => {
    const session = app.registry.get(sessionId);
    if (session && !session.exited) session.pty.write(data);
  });

  ipc.on(SEND.terminalResize, (sessionId: string, cols: number, rows: number) => {
    const session = app.registry.get(sessionId);
    if (!session) return;

    // Remembered even while a remote connection is down: the next ssh spawns at
    // this size so tmux repaints to fit instead of reflowing after the fact.
    if (session.remote) {
      session.remote.cols = cols;
      session.remote.rows = rows;
    }
    if (session.exited) return;

    // A plain terminal repaints its prompt on resize; keeping those redraws out
    // of the buffer is what stops a reattach replaying a stack of prompts.
    if (session.isPlainTerminal) session.output.suppress();

    session.pty.resize(cols, rows);

    if (session.isPlainTerminal) {
      setTimeout(() => session.output.resume(), RESIZE_SETTLE_MS);
      return;
    }

    // First resize after attaching: nudge the size by a column and back, which
    // is what makes a full-screen TUI repaint into the terminal it now has.
    // Skipped for plain terminals, where it produces a duplicate prompt.
    if (!session.firstResize) return;
    session.firstResize = false;
    setTimeout(() => {
      try {
        session.pty.resize(cols + 1, rows);
        setTimeout(() => {
          try { session.pty.resize(cols, rows); } catch { /* gone */ }
        }, NUDGE_DELAY_MS);
      } catch {
        // The session exited between the nudge being scheduled and running.
      }
    }, NUDGE_DELAY_MS);
  });

  /**
   * The renderer let go of a terminal.
   *
   * The session is kept: it may be reattached, and its output keeps buffering
   * so the next attach has something to replay. Only a session that has already
   * exited is dropped, because nothing is coming.
   */
  ipc.on(SEND.closeTerminal, (sessionId: string) => {
    const session = app.registry.get(sessionId);
    if (!session) return;
    session.rendererAttached = false;
    if (session.exited) app.registry.delete(sessionId);
  });

  /** The user's answer to a diff the CLI is blocking on. */
  ipc.on(SEND.mcpDiffResponse, (
    sessionId: string,
    diffId: string,
    action: 'accept' | 'accept-edited' | 'reject',
    editedContent: string | null,
  ) => {
    app.ideBridge.resolveDiff(sessionId, diffId, action, editedContent);
  });
}
