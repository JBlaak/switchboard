/**
 * The running sessions' PTYs behind the SessionPrompter port.
 *
 * A prompt is written the way a terminal pastes: as a bracketed paste
 * (`ESC[200~ … ESC[201~`), which the Claude CLI turns on and reads as one
 * block of input. Without the brackets every newline in a multi-line prompt
 * would be an Enter, and the first line would be sent on its own.
 *
 * Enter is a separate write, a moment later. The CLI coalesces a paste before
 * it lands in the input box (long ones become "[Pasted text #1]"), and a `\r`
 * arriving in the same chunk as the closing bracket can be taken as part of
 * the paste, which leaves the prompt sitting in the box unsent. Typed by hand,
 * Enter comes after the paste has landed; the delay does the same.
 *
 * Busy and idle are the session's own CLI state (`CliBusyTracker`, fed from
 * OSC 7501 or the title), heard through the lifecycle as the renderer hears it.
 */
import type { Timers } from '../../application/ports/clock';
import type { Disposable } from '../../application/ports/git-workspace';
import type { Logger } from '../../application/ports/logger';
import type { SessionPrompter } from '../../application/ports/session-prompter';
import type { CliStateChange } from '../../domain/terminal/osc';

export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';

/** How long after the paste Enter is pressed. */
export const SUBMIT_DELAY_MS = 150;

/** What the prompter reads off a running session. */
export interface PromptableSession {
  readonly pty: { write(data: string): void };
  readonly exited: boolean;
  readonly isPlainTerminal: boolean;
  readonly cliBusy: { readonly busy: boolean; readonly ready: boolean };
  /** Every id the session has answered to, given the one it is keyed by now. */
  allIds(currentKey: string): string[];
}

/** The session registry, as far as the prompter needs it. */
export interface PromptableSessions {
  find(sessionId: string): { key: string; session: PromptableSession } | null;
}

/**
 * The bytes a prompt is pasted as.
 *
 * Inside the brackets only text may appear: an escape (from a CI log's colour
 * codes, say) could close the paste early and have the rest typed as keys,
 * and a carriage return could press Enter half-way. So escapes and other
 * control characters go, and line endings become `\n`, which the CLI keeps as
 * a newline in the message.
 */
export function pasteBytes(prompt: string): string {
  const text = prompt
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  return PASTE_START + text + PASTE_END;
}

export class PtySessionPrompter implements SessionPrompter {
  readonly #listeners = new Map<string, Set<() => void>>();
  readonly #exitListeners = new Map<string, Set<() => void>>();

  constructor(private readonly deps: { sessions: PromptableSessions; timers: Timers; log: Logger }) {}

  runningId(sessionId: string): string | null {
    const found = this.#find(sessionId);
    return found ? found.key : null;
  }

  isBusy(sessionId: string): boolean {
    const found = this.#find(sessionId);
    if (!found) return true;
    const { busy, ready } = found.session.cliBusy;
    return busy || !ready;
  }

  onIdle(sessionId: string, fn: () => void): Disposable {
    return listen(this.#listeners, sessionId, fn);
  }

  onExit(sessionId: string, fn: () => void): Disposable {
    return listen(this.#exitListeners, sessionId, fn);
  }

  send(sessionId: string, prompt: string): void {
    const found = this.#find(sessionId);
    if (!found) {
      this.deps.log.warn(`[session-work] not sending to ${sessionId}: it is not running`);
      return;
    }
    const { session } = found;
    const pty = session.pty;
    pty.write(pasteBytes(prompt));
    this.deps.timers.setTimeout(() => {
      // The session may have ended, or reconnected on a new PTY, in between.
      if (session.exited || session.pty !== pty) return;
      pty.write('\r');
    }, SUBMIT_DELAY_MS);
  }

  /** From the lifecycle: a session's CLI changed state. */
  cliStateChanged(sessionId: string, session: PromptableSession, change: CliStateChange): void {
    const idle = change.kind === 'ready' || (change.kind === 'busy' && !change.busy);
    if (!idle) return;
    this.#notify(this.#listeners, sessionId, session, 'idle');
  }

  /** From the lifecycle: a session's process ended for good. */
  sessionEnded(sessionId: string, session: PromptableSession): void {
    this.#notify(this.#exitListeners, sessionId, session, 'exit');
  }

  /** Call every listener filed under any id the session has answered to. */
  #notify(listeners: Map<string, Set<() => void>>, sessionId: string, session: PromptableSession, what: string): void {
    const fns: Array<() => void> = [];
    for (const id of session.allIds(sessionId)) {
      for (const fn of listeners.get(id) ?? []) fns.push(fn);
    }
    for (const fn of fns) {
      try {
        fn();
      } catch (err) {
        this.deps.log.error(`[session-work] an ${what} listener failed:`, (err as Error).message);
      }
    }
  }

  #find(sessionId: string): { key: string; session: PromptableSession } | null {
    const found = this.deps.sessions.find(sessionId);
    if (!found || found.session.exited || found.session.isPlainTerminal) return null;
    return found;
  }
}

function listen(listeners: Map<string, Set<() => void>>, sessionId: string, fn: () => void): Disposable {
  let set = listeners.get(sessionId);
  if (!set) {
    set = new Set();
    listeners.set(sessionId, set);
  }
  set.add(fn);
  return {
    dispose: () => {
      const current = listeners.get(sessionId);
      if (!current) return;
      current.delete(fn);
      if (current.size === 0) listeners.delete(sessionId);
    },
  };
}
