import { nanoid } from 'nanoid/non-secure';
import { RemoteObjectRegistry } from './remote-object-registry';
import type { ClassDescriptor, FunctionDescriptor, ObjectDescriptor, ObjectDescriptors } from './rpc-descriptor-types';
import type { RPC_DescriptorsResultMessage, RPC_FnCallMessage, RPC_Message, RPC_RpcCallMessage } from './rpc-message-types';

type PromiseCallbacks = {
    resolve: (data?: any) => void;
    reject: (data?: any) => void;
};

export interface RPCChannel {
    sendSync?: (message: RPC_Message) => any,
    sendAsync?: (message: RPC_Message) => void,
    receive?: (callback: (message: any, replyChannel?: RPCChannel) => void) => void
}

export class RPCService {
    private channel: RPCChannel;

    private remoteDescriptors: ObjectDescriptors;
    private asyncCallbacks = new Map<number, PromiseCallbacks>();
    private callId = 0;

    private readonly remoteObjectRegistry = new RemoteObjectRegistry();
    // private readonly localObjectRegistry = new Map<string, any>();

    connect(channel: RPCChannel) {
        this.channel = channel;
        channel.receive?.(this.messageReceived.bind(this));
    }

    registerTargetObject(objId: string, target: object|Function, descriptor: ObjectDescriptor | FunctionDescriptor) {
        descriptor.type = <'object'|'function'>typeof target;
        this.remoteObjectRegistry.register(objId, target, descriptor);
    }
 
    requestRemoteDescriptors() {
        // TODO: async?
        const response = this.sendSyncIfPossible({ action: 'get_descriptors' }) as RPC_DescriptorsResultMessage;
        if (response.error) throw new Error(response.error);
        this.remoteDescriptors = response.descriptors;
    }

    private sendSync(message: RPC_Message, channel = this.channel) {
        this.addMarker(message);
        return channel.sendSync?.(message);
    }

    private sendAsync(message: RPC_Message, channel = this.channel) {
        if (channel.sendAsync) {
            this.addMarker(message);
            channel.sendAsync(message);
            return true;
        }
        return false;
    }

    private sendSyncIfPossible(message: RPC_Message, channel = this.channel) {
        return channel.sendSync ? this.sendSync(message, channel) : this.sendAsync(message, channel);
    }

    private sendAsyncIfPossible(message: RPC_Message, channel = this.channel) {
        return channel.sendAsync ? this.sendAsync(message, channel) : this.sendSync(message, channel);
    }

    private addMarker(message: RPC_Message) {
        message.rpc_marker = 'webrpc';
    }

    private checkMarker(message: RPC_Message): message is RPC_Message {
        return typeof message === 'object' && message.rpc_marker === 'webrpc';
    }


    private getTargetFunction(msg: RPC_FnCallMessage | RPC_RpcCallMessage) {
        const entry = this.remoteObjectRegistry.getObject(msg.objId) as { target: Function, descriptor: FunctionDescriptor|ObjectDescriptor, scope?: object };
        if (!entry) return;

        if (msg.action === 'rpc_call') {
            entry.scope = entry.target;
            entry.target = entry.target?.[msg.prop];
            entry.descriptor = <FunctionDescriptor>(entry.descriptor as ObjectDescriptor).functions?.find(func => typeof func === 'object' && func.name === msg.prop);
        }
        return entry as { target: Function, descriptor: FunctionDescriptor, scope?: object };
    }

    private callTargetFunction(msg: RPC_RpcCallMessage | RPC_FnCallMessage, replyChannel = this.channel) {
        console.log('calltargetfunc');
        const entry = this.getTargetFunction(msg);
        let result: any;
        let success = true;
        try {
            if (!entry) throw new Error(`No object found with ID '${msg.objId}'`);

            result = entry.target.apply(entry.scope, this.deSerializeFunctionArgs(entry.descriptor, msg.args, replyChannel));

            if (msg.callType === 'async') {
                Promise.resolve(result)
                .then(value => result = value, err => { result = err; success = false; })
                .then(() => this.sendAsync({ action: 'rpc_reply', callType: 'async', success, result, callId: msg.callId }, replyChannel));
            }
        } catch (err) {
            success = false;
            result = err?.toString?.();
        }
        if (msg.callType === 'sync') {
            this.sendSync({ action: 'rpc_reply', callType: 'sync', success, result }, replyChannel);
        } else if (msg.callType === 'async' && !success) {
            this.sendAsync({ action: 'rpc_reply', callType: 'async', success, result, callId: msg.callId }, replyChannel);
        }
    }

    messageReceived(message: RPC_Message, replyChannel = this.channel) {
        console.log('received', JSON.stringify(message))   ;

        if (this.checkMarker(message)) {
            switch (message.action) {
                case 'get_descriptors': {
                    this.sendSyncIfPossible({ action: 'descriptors', descriptors: this.remoteObjectRegistry.getObjectDescriptors() }, replyChannel);
                    break;
                }
                case 'fn_call':
                case 'rpc_call': {
                    this.callTargetFunction(message, replyChannel);
                    break;
                }
                // case 'async_fn': {
                //     const fn = this.localObjectRegistry.get(message.objId);
                //     if (!fn) throw new Error(`Remote function not found`);
                //     fn(...message.args.map(arg => this.postprocessSerialization(arg, replyChannel/* , ??? */)));
                //     break;
                // }
                // case 'obj_died': {
                //     this.localObjectRegistry.delete(message.objId);
                //     console.log('objReg #', this.localObjectRegistry.size);
                //     break;
                // }
                case 'rpc_reply': {
                    if (message.callType === 'async') {
                        const callbacks = this.asyncCallbacks.get(message.callId);
                        callbacks[message.success ? 'resolve' : 'reject'](message.result);
                        this.asyncCallbacks.delete(message.callId);
                    }
                    break;
                }
            }
        }
    }

    private getPropName(descriptor: string | FunctionDescriptor) {
        return typeof descriptor === 'string' ? descriptor : descriptor.name;
    }

    private getArgumentDescriptor(func: FunctionDescriptor, idx?: number) {
        console.log('getArgumentDescriptor', func, idx);
        return typeof func === 'object' ? func.arguments?.find(arg => arg.idx == null || arg.idx === idx) : undefined;
    }

    private serializeFunctionArgs(func: FunctionDescriptor, args: any[]) {
        return args.map((arg, idx) => this.preprocessSerialization(arg, /* this.getArgumentDescriptor(func.arguments, idx) */));
    }

    private deSerializeFunctionArgs(func: FunctionDescriptor, args: any[], replyChannel: RPCChannel) {
        return args.map((arg, idx) => this.postprocessSerialization(arg, replyChannel, this.getArgumentDescriptor(func, idx)));
    }

    private createVoidProxyFunction(objId: string, func: FunctionDescriptor) {
        return (...args: any[]) => {
            this.sendAsyncIfPossible({ action: 'rpc_call', callType:'void', objId, 
                prop: func.name, 
                args: this.serializeFunctionArgs(func, args) 
            });
        };
    }

    private createSyncProxyFunction(objId: string, func: FunctionDescriptor) {
        return (...args: any[]) => {
            const response = this.sendSync({ action: 'rpc_call', callType: 'sync', objId, 
                prop: func.name, 
                args: this.serializeFunctionArgs(func, args) 
            });

            if (!response) throw new Error(`No response received`);
            if (typeof response !== 'object' || response.rpc_marker !== 'webrpc') throw new Error(`Invalid response ${JSON.stringify(response)}`);
            if (!response.success) throw new Error(response.result);
            return response.result;
        };
    }

    private createAsyncProxyFunction(objId: string, func: FunctionDescriptor) {
        return (...args: any[]) => new Promise((resolve, reject) => {
            this.callId++;
            this.sendAsync({
                action: 'rpc_call', callType:'async', objId, callId: this.callId,
                prop: func.name, 
                args: this.serializeFunctionArgs(func, args)
            });
            this.asyncCallbacks.set(this.callId, { resolve, reject });
        });
    }

    private createProxyFunction(objId: string, prop: string | FunctionDescriptor) {
        const descriptor = (typeof prop === 'object') ? prop : { name: prop };

        switch (descriptor?.returns || 'async') {
            case 'void': return this.createVoidProxyFunction(objId, descriptor);
            case 'sync': return this.createSyncProxyFunction(objId, descriptor);
            default: return this.createAsyncProxyFunction(objId, descriptor);
        }
    }

    createProxyObject(objId: string) {
        const descriptor = this.remoteDescriptors[objId];
        if (!descriptor) {
            throw new Error(`No object registered with ID '${objId}'`);
        }

        if (typeof descriptor === 'string' || descriptor.type === 'function') {
            return this.createProxyFunction(objId, descriptor);
        }

        const obj = {};

        if (descriptor.functions) for (const prop of descriptor.functions) { 
            obj[this.getPropName(prop)] = this.createProxyFunction(objId, prop);
        }

        return obj;
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
                if (!this.remoteObjectRegistry.has(objId)) {
                    objId = nanoid();
                    this.remoteObjectRegistry.register(objId, obj, {});
                    obj._rpc_objId = objId;
                            // console.log('fnReg #', this.localObjectRegistry.size);
                }
                
                return { _rpc_type: 'function', objId };
            }
        }
        return obj;
    }

    private postprocessSerialization(obj: any, replyChannel: RPCChannel, descriptor?: FunctionDescriptor) {
        switch (typeof obj) {
            case 'object': {
                if (obj._rpc_type === 'function') {
                    return this.createRemoteFunction(obj.objId, replyChannel, descriptor);
                }
                for (const key of Object.keys(obj)) {
                    obj[key] = this.postprocessSerialization(obj[key], replyChannel);
                }
                break;
            }
        }
        return obj;
    }

    private createRemoteFunction(objId: string, replyChannel: RPCChannel, descriptor?: FunctionDescriptor) {
        console.log('createRemoteFunc', objId, descriptor);
        let fn = this.remoteObjectRegistry.getObject(objId)?.target;
        if (!fn) {
            let disposed = false;
            fn = (...args: any[]) => {
                if (disposed) throw new Error(`Remote function has been disposed`);
                this.sendAsync({ action: 'fn_call', callType: 'void' /* ?? */, objId, args: this.serializeFunctionArgs(null, args) }, replyChannel);
            };
            descriptor.type = 'function';
            this.remoteObjectRegistry.register(objId, fn, descriptor, 
                (() => { disposed = true; this.sendAsyncIfPossible({ action: 'obj_died', objId }, replyChannel) }), true);
        }
        return fn;
    }

    registerProxyClass(classId: string, classCtor: any, descriptor: ClassDescriptor) {

    }
}
