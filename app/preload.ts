import {ipcRenderer, contextBridge} from 'electron';

const registeredDescriptors = ipcRenderer.sendSync('channel', 'ready');

console.log(registeredDescriptors);

contextBridge.exposeInMainWorld('api', {
    send: (channel: string, data: any) => ipcRenderer.send(channel, data),
    receive: (channel: string, func: (event: Electron.IpcRendererEvent, ...args: any[]) => void) => ipcRenderer.on(channel, func)
});
