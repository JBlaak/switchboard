/**
 * Typing a prompt into a running session's terminal, the way you would.
 *
 * Every Session work action is a prompt (A1), and a prompt can only go in when
 * Claude is at its prompt: typed mid-turn it would land in the input box and
 * wait there, or worse, answer a question Claude is asking. So the queue needs
 * to know when a session is busy and to hear when it goes idle, and this is
 * the whole of what it needs from a session.
 *
 * A session's id can change under it (a fork, an accepted plan); every method
 * takes any id the session has answered to.
 */
import type { Disposable } from './git-workspace';

export interface SessionPrompter {
  /**
   * The id the session goes by now when it is running Claude, or null when it
   * is not running (or is a plain terminal, which has no Claude to prompt).
   */
  runningId(sessionId: string): string | null;

  /**
   * Is the session unable to take a prompt right now: mid-turn, or started
   * but not at its prompt yet? A session that is not running is busy.
   */
  isBusy(sessionId: string): boolean;

  /**
   * Call `fn` each time the session comes to its prompt: when a turn ends,
   * and when a session that just started first shows its prompt.
   */
  onIdle(sessionId: string, fn: () => void): Disposable;

  /** Call `fn` when the session's process ends (not when a remote one only redials). */
  onExit(sessionId: string, fn: () => void): Disposable;

  /** Type `prompt` in and press Enter, so it arrives as one message however many lines it has. */
  send(sessionId: string, prompt: string): void;
}
