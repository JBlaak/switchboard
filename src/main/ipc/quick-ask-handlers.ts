/**
 * Quick Ask (#142): what the pop-up asks of main, and the main window's word
 * that it is ready for what Quick Ask sends it.
 *
 * The routing and what follows from it are `QuickAskService`'s; this is the
 * window's own plumbing, hiding it and letting the mouse through beside the
 * slab, and the channels into the service. Undo belongs to captures, which
 * #151 brings; until then there is nothing to undo.
 */
import { INVOKE, SEND } from '../../ipc/channels';
import type { Container } from '../composition-root';
import type { IpcRegistrar } from './registrar';

export function registerQuickAskHandlers(ipc: IpcRegistrar, app: Container): void {
  ipc.on(SEND.quickAskDismiss, () => app.quickAskPanel.hide());
  ipc.on(SEND.quickAskPointerOverSlab, (over: boolean) => app.quickAskWindow()?.pointerOverSlab(!!over));
  ipc.on(SEND.rendererReady, () => app.renderer.rendererReady());

  ipc.handle(INVOKE.quickAskRoute, (text: string) => app.quickAsk.route(String(text)));
  ipc.handle(INVOKE.quickAskCancel, () => app.quickAsk.cancel());
  ipc.handle(INVOKE.quickAskStart, (projectPath: string) => app.quickAsk.start(String(projectPath)));
  ipc.handle(INVOKE.quickAskOpenPicker, () => app.quickAsk.openPicker());
  ipc.handle(INVOKE.quickAskUndo, () => ({ ok: false }));
}
