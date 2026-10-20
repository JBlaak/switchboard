/**
 * What Quick Ask does with a routing result (#142, R2).
 *
 * The pop-up has no project list to fall back on, so a request Patch can't
 * place still has to go somewhere: into the Quick Session Folder when one is
 * set, or to the main window's New Session picker, holding the text.
 */
import type { CaptureTarget, QuickRouteResult } from './model';

export type QuickAskOutcome =
  /** Start a session there on `prompt`. */
  | { kind: 'start'; projectPath: string; prompt: string }
  /** Show the choices in the pop-up. */
  | { kind: 'choose'; candidates: string[]; prompt: string }
  /** Bring the main window forward with the New Session picker; `reason` is Patch's line. */
  | { kind: 'picker'; prompt: string; reason?: string }
  | { kind: 'capture'; target: CaptureTarget; text: string }
  /** Back to editing. */
  | { kind: 'unlock' };

/**
 * The R2 table, plus captures.
 *
 * A confident answer starts on the rewritten prompt and an unsure one offers
 * its choices. When nothing fits or the call failed, the text goes on as typed
 * — Haiku's rewrite, if any, was for a project it couldn't name — unless it
 * starts on a skill every project has, which the result then carries.
 * `quickFolder` is the Quick Session Folder, or '' when none is set.
 */
export function quickAskOutcome(result: QuickRouteResult, text: string, quickFolder: string): QuickAskOutcome {
  switch (result.kind) {
    case 'confident':
      return { kind: 'start', projectPath: result.projectPath, prompt: result.prompt };
    case 'unsure':
      return { kind: 'choose', candidates: result.candidates, prompt: result.prompt };
    case 'noMatch':
    case 'failed': {
      const prompt = result.kind === 'noMatch' && result.prompt ? result.prompt : text;
      return quickFolder
        ? { kind: 'start', projectPath: quickFolder, prompt }
        : { kind: 'picker', prompt, reason: result.reason };
    }
    case 'capture':
      return { kind: 'capture', target: result.target, text: result.text };
    case 'cancelled':
      return { kind: 'unlock' };
  }
}

/**
 * What the pop-up is told came of a send, or of a choice from its list.
 *
 * By the time it crosses to the pop-up, main has done what the outcome said:
 * this is only what to show.
 */
export type QuickAskReply =
  /** The session is starting in this project's folder (B7). */
  | { kind: 'started'; folder: string }
  /** Patch is unsure: these projects, best first (R2). */
  | { kind: 'choose'; candidates: { projectPath: string; folder: string }[] }
  /** The main window took the text, in its New Session picker (R2). */
  | { kind: 'handedOff' }
  /** A task or a save was written (C4). */
  | { kind: 'saved'; target: CaptureTarget; summary: string }
  /** A capture failed; the text stays, to retry (C5). */
  | { kind: 'captureFailed'; reason: string }
  /** Cancelled: back to editing. */
  | { kind: 'unlocked' };
