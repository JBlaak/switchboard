/**
 * The Quick Ask pop-up's context-isolation bridge (#142).
 *
 * Like the main window's preload, nothing but wiring, and only the pop-up's
 * own channels: the pop-up cannot reach anything `window.api` can.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { INVOKE, QUICK_ASK_EVENT, SEND } from '../ipc/channels';
import type { CaptureTarget, QuickAskApi, QuickAskLooks } from '../ipc/quick-ask-api';
import type { Unsubscribe } from '../ipc/api';

function subscribe(channel: string, listener: () => void): Unsubscribe {
  const wrapper = (): void => listener();
  ipcRenderer.on(channel, wrapper);
  return () => { ipcRenderer.removeListener(channel, wrapper); };
}

function subscribeWith<T>(channel: string, listener: (value: T) => void): Unsubscribe {
  const wrapper = (_event: unknown, value: T): void => listener(value);
  ipcRenderer.on(channel, wrapper);
  return () => { ipcRenderer.removeListener(channel, wrapper); };
}

const quickAsk: QuickAskApi = {
  route: (text) => ipcRenderer.invoke(INVOKE.quickAskRoute, text),
  quick: (text) => ipcRenderer.invoke(INVOKE.quickAskQuick, text),
  cancel: () => ipcRenderer.invoke(INVOKE.quickAskCancel),
  start: (projectPath) => ipcRenderer.invoke(INVOKE.quickAskStart, projectPath),
  openPicker: () => ipcRenderer.invoke(INVOKE.quickAskOpenPicker),
  undo: () => ipcRenderer.invoke(INVOKE.quickAskUndo),
  dismiss: () => ipcRenderer.send(SEND.quickAskDismiss),
  onShown: (listener) => subscribeWith<QuickAskLooks>(QUICK_ASK_EVENT.shown, listener),
  onSaving: (listener) => subscribeWith<CaptureTarget>(QUICK_ASK_EVENT.saving, listener),
  onCloseRequested: (listener) => subscribe(QUICK_ASK_EVENT.closeRequested, listener),
  pointerOverSlab: (over) => ipcRenderer.send(SEND.quickAskPointerOverSlab, over),
};

contextBridge.exposeInMainWorld('quickAsk', quickAsk);
// As the main window's preload does: the pop-up's motion jumps to its end, for stable screenshots.
if (process.env.SWITCHBOARD_E2E === '1') contextBridge.exposeInMainWorld('switchboardE2E', true);
