/**
 * The real `VmStartSteps`: main hands the start's checkouts off, and the
 * renderer starts the session in the copy, as it starts any VM session.
 */
import {startClaudeSessionOnVm} from '../../features/sessions/session-actions';
import type {VmStartSteps} from './start-on-vm';

export const vmStartSteps: VmStartSteps = {
    handOff: (localPath, hostKey, worktrees, options) =>
        window.api.handOffForStart(localPath, hostKey, worktrees, options),
    launch: (copyPath, options, how) => startClaudeSessionOnVm(copyPath, options, how),
};
