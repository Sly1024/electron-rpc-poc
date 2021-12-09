# PoC for Electron RPC with preloading

## Motivation
Since the "remote" feature was removed from Electron (14), I needed a way to do "remoting" properly. I want to use RPC style communication between the host (node/main) process and the web app (renderer). But not the send-messages-to-call-functions kind of remoting. The "real" way is to call a function on an object on the client side and have it trigger a function call on the host side. I also want to be able to pass functions, like `mainWindow.addListener(...)`. Also some functions might need to return synchronously, others are OK the be async and return a Promise.

The recommended approach is to set these options
```js
webPreferences: {
    nodeIntegration: false,
    contextIsolation: true,
    preload: path.join(__dirname, 'preload.js')
}
```

This means we won't be ale to use `require()` in the web context, so we need a preload script that can access `require()` and use IPC to talk to the host.

## This project contains:
* A "lib" that will be a library published to github/npm
* An "app" that runs in Electron (node)
* A "webapp" that runs in the webpage

## Requirements for the RPC library:
* Must be secure and use the recommended approach (see above)
* Able to provide objects/functions on the client side 
  * like: `api.getWindow("12")` (and not `sendMessage('getWindow', ["12"])`)
* The API is limited to what is specified by the host
  * User needs to explicitly list the objects/functions/classes he wants to expose
  * Each function can be specified as "sync", "async", or "void"
* The RPC library is independent of the communication channel
  * The channel must be passed in
  * sendSync/sendAsync functions are optional, the library will use what is available/specified
  * A `replyChannel` can be passed in at appropriate places - `ipcMain`(electron) does not have a `send` function, it can only reply to messages that can come from multiple windows/contexts
* Ability to pass functions (`addListener`)
  * User can say if the function is
    * async (returns a Promise), 
    * sync (returns the value synchronously) or 
    * void (no need to send back the return value)
  * Do not leak functions - a way to dispose of them
* Can serialize specific **classes** (e.g. `BrowserWindow`)
  * when sending arguments/return values, we check for the class and send a special type identifier
  * when received, the other side constructs an object with the correct prototype (able to call functions on it)
  * Some (configurable) properties are serialized/sent - e.g. an `id` that never changes
  * Other properties are "proxied" calling through to the other side

## Example usage

This is not final, just how I would like to use it.

```js
const service = {
    add: (a, b) => a + b,
    log: (msg) => console.log(msg),
    getWindow: (id) => ...
};

registerTargetObject('service', service, {
    sync: ['add'],
    async: ['getWindow'],
    void: ['log']
});

registerProxyClass('BrowserWindow', BrowserWindow, {
    // static* basically does: registerTargetObject(...)
    staticSync: ['fromId'],
    staticAsync: ['getAllWindows'],

    // these will be available on a deserialized (BrowserWindow) object instance
    async: ['show', 'getBounds', {
        // when a function takes a function argument..
        name: 'addListener',
        arguments: [
            {
                idx: 1, // second
                type: 'function',
                returns: 'void' // 'async', 'sync' or 'void'
            }
        ]
    }],

    readonlyProperties: ['id'],
    proxiedProperties: ['title', 'fullScreen']
});
```