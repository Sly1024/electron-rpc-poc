import {app, BrowserWindow, ipcMain, IpcMainEvent } from 'electron';
import * as path from 'path';
import { RPCChannel, RPCService } from './rpc-proxy';


function createWindow() {
    const rpc = new RPCService();

    rpc.connect({
        receive: (callback: (message: any, replyChannel?: RPCChannel) => void) => {
            ipcMain.on('channel', (event, message) => {
                callback(message, {
                    sendAsync: (msg) => event.reply('channel', msg),
                    sendSync: (msg) => { event.returnValue = msg; }
                });
            });
        }
    });

    let counter = 0;

    const myServerObject = {
        logThis: (msg: string) => (console.log(msg), "OK"),
        add: (a: number, b: number) => a + b,
        callMeLater: (fn) => { setTimeout(() => fn("hello"+ ++counter), 2000); }
    };

    rpc.registerTargetObject('servobj', myServerObject, {
        sync: ['add'],
        async: ['logThis', 'callMeLater']
    });

    const mainWindow = new BrowserWindow({
        width: 800, height: 600,
        webPreferences: {
            nativeWindowOpen: true,
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    mainWindow.loadFile('../index.html');
}



app.whenReady().then(() => {
    createWindow();
});

app.on('window-all-closed', () => app.quit());
