/**
 * Files dropped on a VM session's terminal (#276 stage 5).
 *
 * A local terminal is handed the dropped file's path. On a VM that path does
 * not exist, so the file is uploaded first and the VM's copy's path is what
 * gets typed. Local sessions keep pasting their own paths.
 */

export interface DroppedFiles {
    /**
     * Upload `localPaths` to the session's VM and answer the paths there, in
     * order; an error when the session is not on a VM, a file cannot be read or
     * is too large, or the VM cannot be reached.
     */
    toSession(
        sessionId: string,
        localPaths: string[],
    ): Promise<{ok: true; paths: string[]} | {ok: false; error: string}>;
}

/** The largest file a drop uploads to a VM. */
export const DROPPED_FILE_CAP_BYTES = 64 * 1024 * 1024;
