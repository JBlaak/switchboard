/**
 * The agent's layout paths, made real on the VM.
 *
 * `domain/agent/layout.ts` writes its paths with a leading `$HOME`, so they
 * expand in the remote shell the Mac's provisioner runs. The agent itself
 * opens them with Node, where nothing expands `$HOME`, so it does that here.
 */
import os from 'node:os';

/** `$HOME/…` or `~/…` with the user's home put in; anything else as it is. */
export function expandHome(path: string, home: string = os.homedir()): string {
    if (path === '$HOME' || path === '~') return home;
    if (path.startsWith('$HOME/')) return home + path.slice('$HOME'.length);
    if (path.startsWith('~/')) return home + path.slice(1);
    return path;
}
