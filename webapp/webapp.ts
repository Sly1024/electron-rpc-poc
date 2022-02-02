import { nanoid } from 'nanoid/non-secure';
import { RPCChannel, SuperRPC } from '../lib/super-rpc';
import type { BrowserWindow as ElectronBrowserWindow } from 'electron';

declare const rpcChannel: RPCChannel;

const rpc = new SuperRPC(nanoid);
rpc.connect(rpcChannel);

rpc.requestRemoteDescriptors();

export const api = rpc.getProxyObject('serviceObj');

export const BrowserWindow = <typeof ElectronBrowserWindow>rpc.getProxyClass('BrowserWindow');

const mainWindow = BrowserWindow.fromId(1);

(async () => {
    const boundsSpan = document.getElementById('boundsSpan');
    const currentWindow = await api.getCurrentWindow();
    await currentWindow.addListener('move', async () => {
        boundsSpan.textContent = JSON.stringify(await currentWindow.getBounds());
    });
})();

document.getElementById('newWindowBtn').addEventListener('click', async () => {
    const win = await api.createWindow({
        width: 800, height: 600
    });
    await win.setParentWindow(mainWindow);
    await win.loadFile('../../index.html');
    win.title = 'Example Popup';
});