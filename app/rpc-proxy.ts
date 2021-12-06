type PromiseCallbacks = {
    resolve: (data?: any) => void;
    reject: (data?: any) => void;
};

export type Descriptor = {
    sync?: string[],
    async?: string[]
};

export type ObjectDescriptors = { [key: string] : Descriptor };

type ObjectRegistryEntry = {
    target: any;
    descriptor: Descriptor;
}

type RPCMessageBase = { rpc_marker: 'webrpc' };
type RPCGetDescriptorMessage = RPCMessageBase & { action: 'get_descriptors' };

type RPCFnCallMessageBase = RPCMessageBase & { objId: string, prop: string, args: any[] };
type RPCSyncFnCallMessage = RPCFnCallMessageBase & { action: 'sync_fn' };
type RPCAsyncFnCallMessage = RPCFnCallMessageBase & { action: 'async_fn', callId: number };
type RPCFnCallMessage = RPCSyncFnCallMessage | RPCAsyncFnCallMessage;

type RPCFnResultMessageBase = RPCMessageBase & { success: boolean; result: any };
type RPCSyncFnResultMessage = RPCFnResultMessageBase & { action: 'sync_reply'};
type RPCAsyncFnResultMessage = RPCFnResultMessageBase & { action: 'async_reply', callId: number };
type RPCFnResultMessage = RPCSyncFnResultMessage | RPCAsyncFnResultMessage;
type RPCMessage = RPCGetDescriptorMessage | RPCFnCallMessage | RPCFnResultMessage;

export interface RPCChannel {
    sendSync?: (message: any) => any,
    sendAsync?: (message: any) => void,
    receive?: (callback: (message: any, replyChannel?: RPCChannel) => void) => void
}

export class RPCService {
    private readonly objRegistry = new Map<string, ObjectRegistryEntry>();
    private channel: RPCChannel;

    private remoteDescriptors: ObjectDescriptors;
    private asyncCallbacks = new Map<number, PromiseCallbacks>();
    private callId = 0;

    connect(channel: RPCChannel) {
        this.channel = channel;
        channel.receive?.(this.messageReceived.bind(this));
    }

    registerTargetObject(objId: string, target: any, descriptor: Descriptor) {
        this.objRegistry.set(objId, { target, descriptor });
    }
 
    getRegisteredObjectDescriptors(): ObjectDescriptors {
        const descriptors = {};
        for (const key of this.objRegistry.keys()) {
            descriptors[key] = this.objRegistry.get(key).descriptor;
        }
        return descriptors;
    }

    requestRemoteDescriptors() {
        // TODO: async?
        this.remoteDescriptors = this.sendSyncIfPossible({ action: 'get_descriptors' });
        console.log('got remote descr', this.remoteDescriptors);
    }

    private sendSync(message: any, channel = this.channel) {
        this.addMarker(message);
        return channel.sendSync?.(message);
    }

    private sendAsync(message: any, channel = this.channel) {
        if (channel.sendAsync) {
            this.addMarker(message);
            channel.sendAsync(message);
            return true;
        }
        return false;
    }

    private sendSyncIfPossible(message: any, channel = this.channel) {
        return channel.sendSync ? this.sendSync(message, channel) : this.sendAsync(message, channel);
    }

    private addMarker(message: any) {
        message.rpc_marker = 'webrpc';
    }

    private checkMarker(message: any) {
        return typeof message === 'object' && message.rpc_marker === 'webrpc';
    }

    private callTargetFunction(msg: RPCFnCallMessage, replyChannel = this.channel) {
        const entry = this.objRegistry.get(msg.objId);
        let result: any;
        let success = true;
        try {
            if (!entry) throw new Error(`No object found with ID '${msg.objId}'`);
            result = entry.target[msg.prop](...msg.args);
            if (msg.action === 'async_fn') {
                Promise.resolve(result)
                .then(value => result = value, err => { result = err; success = false; })
                .then(() => this.sendAsync({ action: 'async_reply', success, result, callId: msg.callId }, replyChannel));
            }
        } catch (err) {
            success = false;
            result = err?.toString?.();
        }
        if (msg.action === 'sync_fn') {
            this.sendSync({ action: 'sync_reply', success, result }, replyChannel);
        } else if (!success) {
            this.sendAsync({ action: 'async_reply', success, result, callId: msg.callId }, replyChannel);
        }
    }

    async messageReceived(message: RPCMessage, replyChannel = this.channel) {       
        if (this.checkMarker(message)) {
            switch (message.action) {
                case 'get_descriptors': {
                    this.sendSyncIfPossible(this.getRegisteredObjectDescriptors(), replyChannel);
                    break;
                }
                case 'sync_fn': 
                case 'async_fn': {
                    this.callTargetFunction(message, replyChannel);
                    break;
                }
                case 'async_reply': {
                    const callbacks = this.asyncCallbacks.get(message.callId);
                    callbacks[message.success ? 'resolve' : 'reject'](message.result);
                    this.asyncCallbacks.delete(message.callId);
                    break;
                }
            }
        }
    }

    private createSyncProxyFunction(objId: string, prop: string) {
        return (...args: any[]) => {
            const response = this.sendSync({
                action: 'sync_fn', objId, prop, args
            });
            if (!response) throw new Error(`No response received`);
            if (typeof response !== 'object' || response.rpc_marker !== 'webrpc') throw new Error(`Invalid response ${JSON.stringify(response)}`);
            if (!response.success) throw new Error(response.result);
            return response.result;
        };
    }

    private createAsyncProxyFunction(objId: string, prop: string) {
        return (...args: any[]) => new Promise((resolve, reject) => {
            this.callId++;
            this.sendAsync({
                action: 'async_fn', objId, prop, args,
                callId: this.callId
            });
            this.asyncCallbacks.set(this.callId, { resolve, reject });
        });
    }

    getProxyObject(objId: string) {
        const descriptor = this.remoteDescriptors[objId];
        if (!descriptor) {
            throw new Error(`No object registered with ID '${objId}'`);
        }
        const obj = {};
        
        if (descriptor.sync) for (const prop of descriptor.sync) { obj[prop] = this.createSyncProxyFunction(objId, prop); }
        if (descriptor.async) for (const prop of descriptor.async) { obj[prop] = this.createAsyncProxyFunction(objId, prop); }

        return obj;
    }
}
