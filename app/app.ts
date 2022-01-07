import { app, BrowserWindow, ipcMain } from 'electron';
import { nanoid } from 'nanoid/non-secure';
import * as path from 'path';
import { RPC_Message } from '../lib/rpc-message-types';
import { RPCChannel, RPCService } from '../lib/rpc-proxy';


function createWindow() {
    const rpc = new RPCService(nanoid);

    rpc.connect({
        receive: (callback: (message: RPC_Message, replyChannel?: RPCChannel) => void) => {
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
        logThis: (msg: string) => (console.log(msg), 'OK'),
        add: (a: number, b: number) => a + b,
        callMeLater: (fn) => { console.log('callMeLater'); setTimeout(() => fn('hello'+ ++counter), 2000); },
        callMeIllCallYou: async (fn) => await fn(1023) + 2,
        promiseMe: (p: Promise<string>) => p.then(val => console.log('promised', val))
    };

    rpc.registerHostObject('servobj', myServerObject, {
        functions: [
            'logThis', // async
            'promiseMe',
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

    rpc.registerHostClass('Tiger', Tiger, {
        ctor: {},
        static: { 
            functions: ['withName'],
            proxiedProperties: ['count'],
        },
        instance: {
            functions: [{ name: 'sprint', returns: 'void'}],
            readonlyProperties: ['name'],
            proxiedProperties: [{ name: 'age', get: {returns: 'async'} }]
        }
    });
    
    rpc.registerHostClass('BrowserWindow', BrowserWindow, {
        ctor: { returns: 'sync' },
        static: {
            functions: [{ name: 'fromId', returns: 'sync' }, 'getAllWindows'],
        },
        instance: {
            readonlyProperties: ['id'],
            functions: [
                'close', 'focus', 'blur', 'show', 'hide', 'setBounds', 'getBounds', 'getParentWindow', 'setParentWindow', 'loadURL',
                { name: 'addListener', returns: 'void', arguments: [{ idx: 1, type: 'function', returns: 'void' }]},
                { name: 'removeListener', returns: 'void', arguments: [{ idx: 1, type: 'function', returns: 'void' }]}
            ]
        }
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
