/**
 * Project hand-off to a VM (#276 stage 2): the project page's Hand off to…,
 * its copies and their link back, Bring back and Remove copy.
 *
 * Every call goes to the `ProjectHandoff` façade. A hand-off's and a Bring
 * back's progress lines are pushed to the window as they come, keyed by the
 * project the page asked with. A hand-off that made a copy, and a removed
 * copy, have the project list read again, so the copy appears there or goes.
 *
 * Until the composition root builds the façade, the questions the page asks
 * as it opens (hosts, copies, origin) answer "none", so the page shows no
 * hand-off at all; anything that acts fails with a message.
 */
import {EVENT, INVOKE} from '../../ipc/channels';
import {isRemoteProjectPath} from '../../domain/project/remote-target';
import type {HandoffChoices, ProjectHandoff} from '../../application/services/project-handoff';
import type {Container} from '../composition-root';
import type {IpcRegistrar} from './support/registrar';

/** The façade, until the composition root builds one; a call before then fails with this. */
function handoffOf(app: Container): ProjectHandoff {
    if (!app.projectHandoff) throw new Error('Hand-off isn’t available in this build');
    return app.projectHandoff;
}

/** A local project: a folder on this Mac, not an ssh:// path. */
function localPath(path: unknown): string {
    if (typeof path !== 'string' || path === '' || isRemoteProjectPath(path)) throw new Error('Not a local project');
    return path;
}

/** A copy: an ssh:// project on a VM. */
function copyPath(path: unknown): string {
    if (typeof path !== 'string' || !isRemoteProjectPath(path)) throw new Error('Not a copy on a VM');
    return path;
}

/** The ticked paths, and nothing else the renderer sent. */
function tickedPaths(input: unknown): string[] {
    return Array.isArray(input) ? input.filter((path): path is string => typeof path === 'string') : [];
}

/** The dialog's choices beyond the files, and nothing else the renderer sent. */
export function handoffChoices(input: unknown): HandoffChoices {
    if (!input || typeof input !== 'object') return {};
    const schedulesOnVm = (input as {schedulesOnVm?: unknown}).schedulesOnVm;
    return typeof schedulesOnVm === 'boolean' ? {schedulesOnVm} : {};
}

export function registerHandoffHandlers(ipc: IpcRegistrar, app: Container): void {
    const push = (channel: string, key: string, line: string): void => {
        const window = app.getWindow();
        if (window && !window.isDestroyed()) window.webContents.send(channel, key, line);
    };

    ipc.handle(INVOKE.handoffHosts, () => app.projectHandoff?.hosts() ?? []);

    ipc.handle(INVOKE.handoffPreview, (path: string) => handoffOf(app).preview(localPath(path)));

    ipc.handle(INVOKE.handoffRun, async (path: string, hostKey: string, ticked: unknown, choices: unknown) => {
        const local = localPath(path);
        if (typeof hostKey !== 'string' || !hostKey) throw new Error('No host to hand off to');
        const result = await handoffOf(app).handOff(
            local,
            hostKey,
            tickedPaths(ticked),
            (line) => push(EVENT.handoffProgress, local, line),
            handoffChoices(choices),
        );
        if (result.ok) app.renderer.projectsChanged();
        return result;
    });

    ipc.handle(INVOKE.handoffCopiesOf, (path: string) =>
        typeof path === 'string' && !isRemoteProjectPath(path) ? (app.projectHandoff?.copiesOf(path) ?? []) : [],
    );

    ipc.handle(INVOKE.handoffOriginOf, (path: string) =>
        typeof path === 'string' && isRemoteProjectPath(path) ? (app.projectHandoff?.originOf(path) ?? null) : null,
    );

    ipc.handle(INVOKE.handoffCopyStatus, (path: string) => handoffOf(app).copyStatus(copyPath(path)));

    ipc.handle(INVOKE.handoffBringBack, (path: string) => {
        const copy = copyPath(path);
        return handoffOf(app).bringBack(copy, (line) => push(EVENT.bringBackProgress, copy, line));
    });

    ipc.handle(INVOKE.handoffRemoveCopy, async (path: string) => {
        const result = await handoffOf(app).removeCopy(copyPath(path));
        if (result.ok) app.renderer.projectsChanged();
        return result;
    });
}
