import {nanoid} from 'nanoid/non-secure';

type PromiseCallbacks = {
    resolve: (data?: any) => void;
    reject: (data?: any) => void;
};

export type Descriptor = {
    sync?: string[];
    async?: string[];
};

export type ObjectDescriptors = { [key: string] : Descriptor };

type ObjectRegistryEntry = {
    target: any;
    descriptor: Descriptor;
}

type RPCMessageBase = { rpc_marker?: 'webrpc' };
type RPCGetDescriptorsMessage = RPCMessageBase & { action: 'get_descriptors' };
type RPCDescriptorsResultMessage = RPCMessageBase & { action: 'descriptors', descriptors: ObjectDescriptors, error?: any };

type RPCFnCallMessageBase = RPCMessageBase & { objId: string, prop: string, args: any[] };
type RPCSyncFnCallMessage = RPCFnCallMessageBase & { action: 'sync_rpc' };
type RPCAsyncFnCallMessage = RPCFnCallMessageBase & { action: 'async_rpc', callId: number };
type RPCFnCallMessage = RPCSyncFnCallMessage | RPCAsyncFnCallMessage;

type RPCFnResultMessageBase = RPCMessageBase & { success: boolean; result: any };
type RPCSyncFnResultMessage = RPCFnResultMessageBase & { action: 'sync_reply'};
type RPCAsyncFnResultMessage = RPCFnResultMessageBase & { action: 'async_reply', callId: number };
type RPCFnResultMessage = RPCSyncFnResultMessage | RPCAsyncFnResultMessage;

type RPCObjectDiedMessage = RPCMessageBase & { action: 'obj_died', objId: string };
type RPCAsyncCallbackCallMessage = RPCMessageBase & { action: 'async_fn', objId: string, args: any[] };

type RPCMessage = RPCGetDescriptorsMessage | RPCDescriptorsResultMessage |
    RPCFnCallMessage | RPCFnResultMessage | RPCAsyncCallbackCallMessage | RPCObjectDiedMessage;

export interface RPCChannel {
    sendSync?: (message: RPCMessage) => any,
    sendAsync?: (message: RPCMessage) => void,
    receive?: (callback: (message: any, replyChannel?: RPCChannel) => void) => void
}

export class RPCService {
    private readonly objRegistry = new Map<string, ObjectRegistryEntry>();
    private channel: RPCChannel;

    private remoteDescriptors: ObjectDescriptors;
    private asyncCallbacks = new Map<number, PromiseCallbacks>();
    private callId = 0;

    constructor() {
        this.preprocessSerialization = this.preprocessSerialization.bind(this);
    }

    connect(channel: RPCChannel) {
        this.channel = channel;
        channel.receive?.(this.messageReceived.bind(this));
    }

    registerTargetObject(objId: string, target: any, descriptor: Descriptor) {
        this.objRegistry.set(objId, { target, descriptor });
    }
 
    private getRegisteredObjectDescriptors(): ObjectDescriptors {
        const descriptors = {};
        for (const key of this.objRegistry.keys()) {
            descriptors[key] = this.objRegistry.get(key).descriptor;
        }
        return descriptors;
    }

    requestRemoteDescriptors() {
        // TODO: async?
        const response = this.sendSyncIfPossible({ action: 'get_descriptors' }) as RPCDescriptorsResultMessage;
        if (response.error) throw new Error(response.error);
        this.remoteDescriptors = response.descriptors;
    }

    private sendSync(message: RPCMessage, channel = this.channel) {
        this.addMarker(message);
        return channel.sendSync?.(message);
    }

    private sendAsync(message: RPCMessage, channel = this.channel) {
        if (channel.sendAsync) {
            this.addMarker(message);
            channel.sendAsync(message);
            return true;
        }
        return false;
    }

    private sendSyncIfPossible(message: RPCMessage, channel = this.channel) {
        return channel.sendSync ? this.sendSync(message, channel) : this.sendAsync(message, channel);
    }

    private sendAsyncIfPossible(message: RPCMessage, channel = this.channel) {
        return channel.sendAsync ? this.sendAsync(message, channel) : this.sendSync(message, channel);
    }

    private addMarker(message: RPCMessage) {
        message.rpc_marker = 'webrpc';
    }

    private checkMarker(message: RPCMessage): message is RPCMessage {
        return typeof message === 'object' && message.rpc_marker === 'webrpc';
    }

    private callTargetFunction(msg: RPCFnCallMessage, replyChannel = this.channel) {
        const entry = this.objRegistry.get(msg.objId);
        let result: any;
        let success = true;
        try {
            if (!entry) throw new Error(`No object found with ID '${msg.objId}'`);
            result = entry.target[msg.prop](...msg.args.map(arg => this.postprocessSerialization(arg, replyChannel)));
            if (msg.action === 'async_rpc') {
                Promise.resolve(result)
                .then(value => result = value, err => { result = err; success = false; })
                .then(() => this.sendAsync({ action: 'async_reply', success, result, callId: msg.callId }, replyChannel));
            }
        } catch (err) {
            success = false;
            result = err?.toString?.();
        }
        if (msg.action === 'sync_rpc') {
            this.sendSync({ action: 'sync_reply', success, result }, replyChannel);
        } else if (!success) {
            this.sendAsync({ action: 'async_reply', success, result, callId: msg.callId }, replyChannel);
        }
    }

    messageReceived(message: RPCMessage, replyChannel = this.channel) {    
        // console.log('received', JSON.stringify(message))   ;

        if (this.checkMarker(message)) {
            switch (message.action) {
                case 'get_descriptors': {
                    this.sendSyncIfPossible({ action: 'descriptors', descriptors: this.getRegisteredObjectDescriptors() }, replyChannel);
                    break;
                }
                case 'sync_rpc': 
                case 'async_rpc': {
                    this.callTargetFunction(message, replyChannel);
                    break;
                }
                case 'async_fn': {
                    const fn = this.localObjectRegistry.get(message.objId);
                    if (!fn) throw new Error(`Remote function not found`);
                    fn(...message.args.map(arg => this.postprocessSerialization(arg, replyChannel)));
                    break;
                }
                case 'obj_died': {
                    this.localObjectRegistry.delete(message.objId);
                    console.log('objReg #', this.localObjectRegistry.size);
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
            const response = this.sendSync({ action: 'sync_rpc', objId, prop, args: args.map(this.preprocessSerialization) });

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
                action: 'async_rpc', objId, prop, args: args.map(this.preprocessSerialization),
                callId: this.callId
            });
            this.asyncCallbacks.set(this.callId, { resolve, reject });
        });
    }

    createProxyObject(objId: string) {
        const descriptor = this.remoteDescriptors[objId];
        if (!descriptor) {
            throw new Error(`No object registered with ID '${objId}'`);
        }
        const obj = {};
        
        if (descriptor.sync) for (const prop of descriptor.sync) { obj[prop] = this.createSyncProxyFunction(objId, prop); }
        if (descriptor.async) for (const prop of descriptor.async) { obj[prop] = this.createAsyncProxyFunction(objId, prop); }

        return obj;
    }

    private localObjectRegistry = new Map<string, any>();
    private remoteObjectRegistry = new Map<string, WeakRef<any>>();

    private remoteObjectFinalized = new FinalizationRegistry((dispose: () => void) => dispose());

    private remoteObjectDisposed(objId: string, uregToken: object, replyChannel: RPCChannel) {
        this.remoteObjectFinalized.unregister(uregToken);
        this.remoteObjectRegistry.delete(objId);
        this.sendAsyncIfPossible({ action: 'obj_died', objId }, replyChannel);
    }
    
    private registerRemoteObject(objId: string, obj: any, replyChannel: RPCChannel, dispose?: () => void) {
        const unregToken = {};
        obj._rpc_dispose = () => { dispose?.(); this.remoteObjectDisposed(objId, unregToken, replyChannel); }
        this.remoteObjectFinalized.register(obj, obj._rpc_dispose, unregToken);
        this.remoteObjectRegistry.set(objId, new WeakRef(obj));
    }

    private preprocessSerialization(obj: any) {
        switch (typeof obj) {
            case 'object': {
                for (const key of Object.keys(obj)) {
                    obj[key] = this.preprocessSerialization(obj[key]);
                }
                break;
            }
            case 'function': {
                let objId = obj._rpc_objId;
                if (!this.localObjectRegistry.has(objId)) {
                    objId = nanoid();
                    this.localObjectRegistry.set(objId, obj);
                    obj._rpc_objId = objId;
                            console.log('fnReg #', this.localObjectRegistry.size);
                }
                
                return { _rpc_type: 'function', objId };
            }
        }
        return obj;
    }

    private postprocessSerialization(obj: any, replyChannel: RPCChannel) {
        switch (typeof obj) {
            case 'object': {
                if (obj._rpc_type === 'function') {
                    return this.createRemoteFunction(obj.objId, replyChannel);
                }
                for (const key of Object.keys(obj)) {
                    obj[key] = this.postprocessSerialization(obj[key], replyChannel);
                }
                break;
            }
        }
        return obj;
    }

    private createRemoteFunction(objId: string, replyChannel: RPCChannel) {
        let fn = this.remoteObjectRegistry.get(objId)?.deref();
        if (!fn) {
            let disposed = false;
            fn = (...args: any[]) => {
                if (disposed) throw new Error(`Remote function has been disposed`);
                this.sendAsync({ action: 'async_fn', objId, args: args.map(this.preprocessSerialization) }, replyChannel);
            };
            this.registerRemoteObject(objId, fn, replyChannel, () => disposed = true);
        }
        return fn;
    }

    

}
