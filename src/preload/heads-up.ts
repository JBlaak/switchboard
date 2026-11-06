/**
 * The 1Password heads-up pop-up's context-isolation bridge: only its own
 * channels, as Quick Ask's preload does.
 */
import {contextBridge, ipcRenderer} from 'electron';
import {HEADS_UP_EVENT, SEND} from '../ipc/channels';
import type {HeadsUpApi, HeadsUpShown} from '../ipc/heads-up-api';

const headsUp: HeadsUpApi = {
    answer: (id, answer) => ipcRenderer.send(SEND.headsUpAnswer, id, answer),
    ready: () => ipcRenderer.send(SEND.headsUpReady),
    onShown: (listener) => {
        const wrapper = (_event: unknown, shown: HeadsUpShown): void => listener(shown);
        ipcRenderer.on(HEADS_UP_EVENT.shown, wrapper);
        return () => {
            ipcRenderer.removeListener(HEADS_UP_EVENT.shown, wrapper);
        };
    },
};

contextBridge.exposeInMainWorld('headsUp', headsUp);
if (process.env.SWITCHBOARD_E2E === '1') contextBridge.exposeInMainWorld('switchboardE2E', true);
