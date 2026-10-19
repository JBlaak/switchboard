const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('spike', { send: (ch, v) => ipcRenderer.send(ch, v) });
