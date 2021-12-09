import {app, BrowserWindow, ipcMain, IpcMainEvent } from 'electron';
import * as path from 'path';
import { RPCChannel, RPCService } from '../lib/rpc-proxy';


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
        callMeLater: (fn) => { console.log('callMeLater'); setTimeout(() => fn("hello"+ ++counter), 2000); }
    };

    rpc.registerTargetObject('servobj', myServerObject, {
        functions: [
            'logThis', // async
            { name: 'add', returns: 'sync' },
            { name: 'callMeLater', returns: 'void', arguments:[ { returns: 'void' } ] }
        ]
    });

    class Tiger {
        static withName(name: string) {
            return new Tiger(name);
        }

        constructor (private _name: string) {}

        get name() { return this._name; }

        sprint() {
            console.log(`${this._name} sprints.`);
        }
    }

    rpc.registerProxyClass('Tiger', Tiger, {
        staticFunctions: ['withName'],
        functions: [{ name: 'sprint', returns: 'void'}],
        readonlyProperties: ['name']
    });


    const mainWindow = new BrowserWindow({
        width: 1200, height: 850,
        webPreferences: {
            nativeWindowOpen: true,
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, '../lib/preload.js')
        }
    });

    mainWindow.loadFile('../../index.html');
}



app.whenReady().then(() => {
    createWindow();
});

app.on('window-all-closed', () => app.quit());
