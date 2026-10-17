/**
 * Whether a row's meta line is the button that opens Session work (D2), or
 * plain text whose tooltip says why the page cannot open for it (D14).
 */
import type { SessionKind } from '../../../domain/session/session';

export const REMOTE_REASON = "Session work isn't available for remote sessions yet";
export const NO_REPO_REASON = 'Not a git repository';

export type WorkTrigger = { readonly button: true } | { readonly button: false; readonly reason: string | undefined };

/** A remote session, by its type or by an `ssh://` project path. */
export function isRemoteRow(session: { readonly type?: SessionKind }, path: string | null | undefined): boolean {
  return session.type === 'remote' || !!path?.startsWith('ssh://');
}

/**
 * The meta line for a row, given main's answer to whether the page can open
 * (undefined while it is being asked; a remote row is never asked).
 */
export function workTrigger(remote: boolean, canOpen: boolean | undefined): WorkTrigger {
  if (canOpen === true && !remote) return { button: true };
  return { button: false, reason: remote ? REMOTE_REASON : canOpen === false ? NO_REPO_REASON : undefined };
}
