import {ipcRenderer, contextBridge} from 'electron';
import {RPCChannel, RPCService} from './rpc-proxy';

// a communication channel
const channel: RPCChannel = {
    sendSync: (message: any) => ipcRenderer.sendSync('channel', message),
    sendAsync: (message: any) => ipcRenderer.send('channel', message),
    receive: (callback: (message: any, replyChannel?: RPCChannel) => void) => { 
        ipcRenderer.on('channel', (event, message) => callback(message));
    }
}

const rpc = new RPCService();
rpc.connect(channel);

rpc.requestRemoteDescriptors();

const api = rpc.getProxyObject('servobj');
contextBridge.exposeInMainWorld('api', api);

// contextBridge.exposeInMainWorld('api', {
//     send: (channel: string, data: any) => ipcRenderer.send(channel, data),
//     receive: (channel: string, func: (event: Electron.IpcRendererEvent, ...args: any[]) => void) => ipcRenderer.on(channel, func),        
// });

