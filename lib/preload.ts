import {ipcRenderer, contextBridge} from 'electron';
import type {RPCChannel} from './rpc-proxy';

// a communication channel
const channel: RPCChannel = {
    sendSync: (message: any) => ipcRenderer.sendSync('channel', message),
    sendAsync: (message: any) => ipcRenderer.send('channel', message),
    receive: (callback: (message: any, replyChannel?: RPCChannel) => void) => { 
        ipcRenderer.on('channel', (event, message) => callback(message));
    }
}

contextBridge.exposeInMainWorld('rpcChannel', channel);
