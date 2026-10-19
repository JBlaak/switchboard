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
 * — Haiku's rewrite, if any, was for a project it couldn't name. `quickFolder`
 * is the Quick Session Folder, or '' when none is set.
 */
export function quickAskOutcome(result: QuickRouteResult, text: string, quickFolder: string): QuickAskOutcome {
  switch (result.kind) {
    case 'confident':
      return { kind: 'start', projectPath: result.projectPath, prompt: result.prompt };
    case 'unsure':
      return { kind: 'choose', candidates: result.candidates, prompt: result.prompt };
    case 'noMatch':
    case 'failed':
      return quickFolder
        ? { kind: 'start', projectPath: quickFolder, prompt: text }
        : { kind: 'picker', prompt: text, reason: result.reason };
    case 'capture':
      return { kind: 'capture', target: result.target, text: result.text };
    case 'cancelled':
      return { kind: 'unlock' };
  }
}
