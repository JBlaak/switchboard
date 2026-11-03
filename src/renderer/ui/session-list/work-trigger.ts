/**
 * Whether a row's meta line is the button that opens Session work (D2), or
 * plain text whose tooltip says why the page cannot open for it (D14).
 */
import type {SessionKind} from '../../../domain/session/session';

export const REMOTE_REASON = "Session work isn't available for remote sessions yet";
export const NO_REPO_REASON = 'Not a git repository';
/** On a VM (#276) the page comes in a later stage. */
export const VM_REASON = "Session work isn't available on a VM yet";

export type WorkTrigger = {readonly button: true} | {readonly button: false; readonly reason: string | undefined};

/** A remote session, by its type or by an `ssh://` project path. */
export function isRemoteRow(session: {readonly type?: SessionKind}, path: string | null | undefined): boolean {
    return session.type === 'remote' || !!path?.startsWith('ssh://');
}

/**
 * The meta line for a row, given main's answer to whether the page can open
 * (undefined while it is being asked; a remote row is never asked). `vm` is a
 * remote row whose host runs a Switchboard agent, which says so.
 */
export function workTrigger(remote: boolean, canOpen: boolean | undefined, {vm = false} = {}): WorkTrigger {
    if (canOpen === true && !remote) return {button: true};
    const remoteReason = vm ? VM_REASON : REMOTE_REASON;
    return {button: false, reason: remote ? remoteReason : canOpen === false ? NO_REPO_REASON : undefined};
}
