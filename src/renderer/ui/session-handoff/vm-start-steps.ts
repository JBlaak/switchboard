/**
 * The real `VmStartSteps`: main hands the start's checkouts off, and the
 * renderer starts the session in the copy, as it starts any VM session.
 */
import {startClaudeSessionOnVm} from '../../features/sessions/session-actions';
import type {VmStartSteps} from './start-on-vm';

export const vmStartSteps: VmStartSteps = {
    handOff: async (localPath, hostKey, worktrees, options, onProgress) => {
        // Main reports the hand-off's steps per project; hear this one's while it runs.
        const stop = onProgress
            ? window.api.onHandoffProgress((path, line) => {
                  if (path === localPath) onProgress(line);
              })
            : null;
        try {
            return await window.api.handOffForStart(localPath, hostKey, worktrees, options);
        } finally {
            stop?.();
        }
    },
    launch: (copyPath, options, how) => startClaudeSessionOnVm(copyPath, options, how),
};
