import {ipcRenderer, contextBridge} from 'electron';
import type {RPCChannel} from './rpc-proxy';

// a communication channel
const channel: RPCChannel = {
    sendSync: (message: any) => {
        const result = ipcRenderer.sendSync('channel', message);
        if (result?.error) throw new Error(result.error);
        return result;
    },
    sendAsync: (message: any) => ipcRenderer.send('channel', message),
    receive: (callback: (message: any, replyChannel?: RPCChannel) => void) => { 
        ipcRenderer.on('channel', (event, message) => callback(message));
    }
}

contextBridge.exposeInMainWorld('rpcChannel', channel);
