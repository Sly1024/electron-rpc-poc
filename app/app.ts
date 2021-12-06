import {app, BrowserWindow, ipcMain, IpcMainEvent } from 'electron';
import * as path from 'path';


function createWindow() {
    const mainWindow = new BrowserWindow({
        width: 800, height: 600,
        webPreferences: {
            nativeWindowOpen: true,
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    const myServerObject = {
        logThis: (msg: string) => console.log(msg),
        add: (a: number, b: number) => a + b
    };


    registerTargetObject('servobj', myServerObject, {
        sync: ['add'],
        async: ['logThis']
    });

    ipcMain.on('channel', (event, message) => {
        if (message = 'ready') {
            event.returnValue = getRegisteredObjectDescriptors();
            return;
        }
        
    });

    mainWindow.loadFile('../index.html');
}



app.whenReady().then(() => {
    createWindow();
});

app.on('window-all-closed', () => app.quit());

type ObjectRegistryEntry = {
    target: any;
    descriptor: any;
}
const objRegistry = new Map<string, ObjectRegistryEntry>();

function registerTargetObject(objId: string, target: any, descriptor: any) {
    objRegistry.set(objId, { target, descriptor });
}

function getRegisteredObjectDescriptors() {
    const descriptors = {};
    for (const key of objRegistry.keys()) {
        descriptors[key] = objRegistry.get(key).descriptor;
    }
    return descriptors;
}