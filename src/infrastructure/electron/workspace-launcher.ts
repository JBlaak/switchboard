/**
 * The WorkspaceLauncher on macOS: `open -a` for an app, Electron's
 * `shell.openPath` for a Finder window.
 *
 * `open -a` exits non-zero when no app goes by that name, which is how a
 * missing IDE or iTerm is noticed and the next one tried.
 */
import {execFile} from 'node:child_process';
import {shell} from 'electron';
import type {Logger} from '../../application/ports/logger';
import type {WorkspaceLauncher} from '../../application/ports/workspace-launcher';

const OPEN = '/usr/bin/open';

export class MacWorkspaceLauncher implements WorkspaceLauncher {
    constructor(private readonly log: Logger) {}

    public openWith(app: string, directory: string): Promise<boolean> {
        return new Promise((resolve) => {
            // argv, not a shell line: neither the app's name nor the path is parsed.
            execFile(OPEN, ['-a', app, directory], {timeout: 15_000}, (err) => {
                if (err) this.log.info('[workspace] open -a', app, 'failed:', err.message.trim());
                resolve(!err);
            });
        });
    }

    public async showInFinder(directory: string): Promise<boolean> {
        // Resolves to an error message, '' when the folder opened.
        const error = await shell.openPath(directory);
        if (error) this.log.warn('[workspace] Finder could not open', directory, error);
        return !error;
    }
}
