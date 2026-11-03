/**
 * Whether a row's meta line is the button that opens Session work (D2), or
 * plain text whose tooltip says why the page cannot open for it (D14).
 */
import type {SessionKind} from '../../../domain/session/session';

export const REMOTE_REASON = "Session work isn't available for remote sessions yet";
export const NO_REPO_REASON = 'Not a git repository';
/** A shell on a VM (#276) has no conversation to review. */
export const VM_SHELL_REASON = "Session work isn't available for shells on a VM";

export type WorkTrigger = {readonly button: true} | {readonly button: false; readonly reason: string | undefined};

/** A remote session, by its type or by an `ssh://` project path. */
export function isRemoteRow(session: {readonly type?: SessionKind}, path: string | null | undefined): boolean {
    return session.type === 'remote' || !!path?.startsWith('ssh://');
}

/**
 * Why the page cannot open for a session without asking main, or null when
 * main is to be asked: a local session, or (#276 stage 4) a Claude session on
 * a VM, whose host runs a Switchboard agent (`vm`). An agentless remote's
 * session and a VM's shell stay off.
 */
export function workOffReason(
    session: {readonly type?: SessionKind; readonly remoteKind?: string},
    path: string | null | undefined,
    vm: boolean,
): string | null {
    if (!isRemoteRow(session, path)) return null;
    if (!vm) return REMOTE_REASON;
    return session.remoteKind === 'shell' ? VM_SHELL_REASON : null;
}

/**
 * The meta line for a row, given why it is off before main is asked (see
 * `workOffReason`) and otherwise main's answer to whether the page can open
 * (undefined while it is being asked).
 */
export function workTrigger(offReason: string | null, canOpen: boolean | undefined): WorkTrigger {
    if (offReason !== null) return {button: false, reason: offReason};
    if (canOpen === true) return {button: true};
    return {button: false, reason: canOpen === false ? NO_REPO_REASON : undefined};
}
