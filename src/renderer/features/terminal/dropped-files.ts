/**
 * What a file dropped on a terminal types (#276 stage 5).
 *
 * A local session (and an agentless remote one, as before) is handed the
 * file's own path. On a VM session that path doesn't exist, so the file is
 * uploaded first and the path on the VM is what gets typed, quoted the same
 * way. While it uploads a note says so; on an error the note says that, and
 * nothing is typed.
 *
 * Pure, so it is tested in node; `terminal-manager` does the uploading.
 */
import {posixQuote} from '../../../domain/shell/quoting';

export type DropPlan =
    /** Type these quoted local paths now. */
    | {readonly kind: 'paste'; readonly text: string}
    /** Upload these to the session's VM first, saying `note` while it does. */
    | {readonly kind: 'upload'; readonly localPaths: readonly string[]; readonly note: string};

/** What a drop of `localPaths` does, on a VM session or not; null for a drop with no files. */
export function dropPlan(localPaths: readonly string[], vm: boolean): DropPlan | null {
    const paths = localPaths.filter((path) => path !== '');
    if (paths.length === 0) return null;
    if (!vm) return {kind: 'paste', text: typedPaths(paths)};
    return {kind: 'upload', localPaths: paths, note: uploadingNote(paths.length)};
}

/** "Uploading 2 files to the VM…". */
export function uploadingNote(n: number): string {
    return `Uploading ${n} ${n === 1 ? 'file' : 'files'} to the VM…`;
}

export type UploadOutcome =
    {readonly kind: 'type'; readonly text: string} | {readonly kind: 'error'; readonly message: string};

/**
 * What an upload's answer types: the VM's paths, quoted and space-separated
 * as a local drop's are; or, for an error (or an answer with no paths), the
 * message to show, and nothing typed.
 */
export function afterUpload(answer: unknown): UploadOutcome {
    if (answer && typeof answer === 'object') {
        const result = answer as {ok?: unknown; paths?: unknown; error?: unknown};
        if (result.ok === true && Array.isArray(result.paths)) {
            const paths = result.paths.filter((path): path is string => typeof path === 'string' && path !== '');
            if (paths.length > 0) return {kind: 'type', text: typedPaths(paths)};
        }
        if (typeof result.error === 'string' && result.error) {
            return {kind: 'error', message: 'Couldn’t upload to the VM: ' + result.error};
        }
    }
    return {kind: 'error', message: 'Couldn’t upload to the VM'};
}

function typedPaths(paths: readonly string[]): string {
    return paths.map(posixQuote).join(' ');
}
