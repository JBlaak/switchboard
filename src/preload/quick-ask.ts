/**
 * The Quick Ask pop-up's context-isolation bridge (#142).
 *
 * Like the main window's preload, nothing but wiring, and only the pop-up's
 * own channels: the pop-up cannot reach anything `window.api` can.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { INVOKE, QUICK_ASK_EVENT, SEND } from '../ipc/channels';
import type { QuickAskApi } from '../ipc/quick-ask-api';
import type { Unsubscribe } from '../ipc/api';

function subscribe(channel: string, listener: () => void): Unsubscribe {
  const wrapper = (): void => listener();
  ipcRenderer.on(channel, wrapper);
  return () => { ipcRenderer.removeListener(channel, wrapper); };
}

const quickAsk: QuickAskApi = {
  route: (text) => ipcRenderer.invoke(INVOKE.quickAskRoute, text),
  cancel: () => ipcRenderer.invoke(INVOKE.quickAskCancel),
  start: (projectPath) => ipcRenderer.invoke(INVOKE.quickAskStart, projectPath),
  openPicker: () => ipcRenderer.invoke(INVOKE.quickAskOpenPicker),
  undo: () => ipcRenderer.invoke(INVOKE.quickAskUndo),
  dismiss: () => ipcRenderer.send(SEND.quickAskDismiss),
  onShown: (listener) => subscribe(QUICK_ASK_EVENT.shown, listener),
  onCloseRequested: (listener) => subscribe(QUICK_ASK_EVENT.closeRequested, listener),
  pointerOverSlab: (over) => ipcRenderer.send(SEND.quickAskPointerOverSlab, over),
};

contextBridge.exposeInMainWorld('quickAsk', quickAsk);
