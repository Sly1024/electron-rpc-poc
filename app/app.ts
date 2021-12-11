import {app, BrowserWindow, ipcMain } from 'electron';
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
        callMeLater: (fn) => { console.log('callMeLater'); setTimeout(() => fn("hello"+ ++counter), 2000); },
        callMeIllCallYou: async (fn) => await fn(1023) + 2
    };

    rpc.registerTargetObject('servobj', myServerObject, {
        functions: [
            'logThis', // async
            { name: 'add', returns: 'sync' },
            { name: 'callMeLater', returns: 'void', arguments:[ { returns: 'void' } ] },
            { name: 'callMeIllCallYou', returns: 'void', arguments:[ { type: 'function', returns: 'async' } ] }
        ]
    });

    class Tiger {
        static count = 0;

        static withName(name: string) {
            return new Tiger(name);
        }

        constructor (private _name: string) {
            Tiger.count++;
        }

        get name() { return this._name; }

        age = 1;

        sprint() {
            console.log(`${this._name} sprints.`);
        }
    }

    rpc.registerProxyClass('Tiger', Tiger, {
        staticFunctions: ['withName'],
        staticProperties: ['count'],

        functions: [{ name: 'sprint', returns: 'void'}],
        readonlyProperties: ['name'],
        proxiedProperties: ['age']
    });

    rpc.registerProxyClass('BrowserWindow', BrowserWindow, {
        staticFunctions: [{ name: 'fromId', returns: 'sync' }, 'getAllWindows'],
        readonlyProperties: ['id'],
        functions: ['close', 'focus', 'blur', 'show', 'hide', 'setBounds', 'getBounds', 'getParentWindow', 'setParentWindow',
            { name: 'addListener', returns: 'void', arguments: [{ idx: 1, type: 'function', returns: 'void' }]},
            { name: 'removeListener', returns: 'void', arguments: [{ idx: 1, type: 'function', returns: 'void' }]}
        ]
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
