/**
 * The host capabilities the UI reaches for.
 */
import {INVOKE, SEND} from '../../ipc/channels';
import {isAgentlessRemote} from '../../domain/project/agentless-remote';
import {repoWebUrl} from '../../domain/project/repo-url';
import type {Container} from '../composition-root';
import type {IpcRegistrar} from './support/registrar';

export function registerHostHandlers(ipc: IpcRegistrar, app: Container): void {
    // ── Host ──
    ipc.handle(INVOKE.openExternal, (url: string) => app.system.openExternal(url));
    // A VM project's origin is read on the VM (#276 stage 4); an agentless remote's is out of reach.
    ipc.handle(INVOKE.openRepository, async (projectPath: string) => {
        if (typeof projectPath !== 'string' || isAgentlessRemote(projectPath, app.settings.vmHosts())) {
            return false;
        }
        const remote = await app.git.originUrl(projectPath);
        const url = remote && repoWebUrl(remote);
        if (!url) return false;
        await app.system.openExternal(url);
        return true;
    });
    ipc.handle(INVOKE.writeClipboard, (text: string) => {
        app.system.writeClipboard(text);
    });
    ipc.handle(INVOKE.writeClipboardImage, (png: Uint8Array) => {
        app.system.writeClipboardImage(png);
    });
    ipc.handle(INVOKE.getAppVersion, () => app.system.appVersion());

    // ── Window ──
    ipc.on(SEND.windowDragStart, () => app.windowDrag.start());
    ipc.on(SEND.windowDragMove, (dx: number, dy: number) => app.windowDrag.move(dx, dy));
    ipc.on(SEND.windowDragEnd, () => app.windowDrag.end());
    ipc.on(SEND.needsInputCount, (count: number) => app.dockAttention.set(count));
}
