/**
 * The session tray's Workspace group (#342): which IDE a session's folder
 * opens in, and opening it there, in Finder or in a shell.
 */
import {INVOKE} from '../../ipc/channels';
import type {WorkspaceTarget} from '../../domain/workspace/model';
import type {Container} from '../composition-root';
import type {IpcRegistrar} from './support/registrar';

export function registerWorkspaceHandlers(ipc: IpcRegistrar, app: Container): void {
    ipc.handle(INVOKE.workspaceEditor, (target: WorkspaceTarget) => app.workspace.editorFor(targetOf(target)));
    ipc.handle(INVOKE.workspaceOpenInEditor, (target: WorkspaceTarget) => app.workspace.openInEditor(targetOf(target)));
    ipc.handle(INVOKE.workspaceRevealInFinder, (target: WorkspaceTarget) =>
        app.workspace.revealInFinder(targetOf(target)),
    );
    ipc.handle(INVOKE.workspaceShellHere, (target: WorkspaceTarget) => app.workspace.shellHere(targetOf(target)));
}

/** A target as sent, narrowed to strings: a session id, else a directory ('' when neither). */
function targetOf(target: WorkspaceTarget | null | undefined): WorkspaceTarget {
    if (target && 'sessionId' in target && typeof target.sessionId === 'string') return {sessionId: target.sessionId};
    if (target && 'directory' in target && typeof target.directory === 'string') return {directory: target.directory};
    return {directory: ''};
}
