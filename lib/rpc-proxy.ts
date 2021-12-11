import { nanoid } from 'nanoid/non-secure';
import { RemoteObjectRegistry } from './remote-object-registry';
import type { ClassDescriptor, Descriptor, FunctionDescriptor, FunctionReturnType, ObjectDescriptor, ObjectDescriptors } from './rpc-descriptor-types';
import type { RPC_CallAction, RPC_DescriptorsResultMessage, RPC_FnCallMessage, RPC_Message, RPC_RpcCallMessage } from './rpc-message-types';
import { ClassDescriptors } from './rpc-descriptor-types';


type PromiseCallbacks = {
    resolve: (data?: any) => void;
    reject: (data?: any) => void;
};

type ClassRegistryEntry = {
    descriptor: ClassDescriptor;
    classCtor: new () => any;
};

type LocalObjectRegistryEntry = {
    target: any;
    descriptor: Descriptor;
};

type TargetFunctionEntry = { target: Function, descriptor: FunctionDescriptor, scope?: object };
export interface RPCChannel {
    sendSync?: (message: RPC_Message) => any,
    sendAsync?: (message: RPC_Message) => void,
    receive?: (callback: (message: any, replyChannel?: RPCChannel) => void) => void
}

export class RPCService {
    private channel: RPCChannel;

    private remoteObjectDescriptors: ObjectDescriptors;
    private remoteClassDescriptors: ClassDescriptors;
    private asyncCallbacks = new Map<number, PromiseCallbacks>();
    private callId = 0;

    private readonly remoteObjectRegistry = new RemoteObjectRegistry();
    private readonly localObjectRegistry = new Map<string, LocalObjectRegistryEntry>();

    connect(channel: RPCChannel) {
        this.channel = channel;
        channel.receive?.(this.messageReceived.bind(this));
    }

    registerTargetObject(objId: string, target: object|Function, descriptor: Descriptor) {
        descriptor.type = <'object'|'function'>typeof target;
        this.localObjectRegistry.set(objId, { target, descriptor });
    }
 
    requestRemoteDescriptors() {
        // TODO: async?
        const response = this.sendSyncIfPossible({ action: 'get_descriptors' }) as RPC_DescriptorsResultMessage;
        if (response.error) throw new Error(response.error);
        this.remoteObjectDescriptors = response.objects;
        this.remoteClassDescriptors = response.classes;
    }

    private getDescriptors<TDescriptor>(registry: Map<string, { descriptor: TDescriptor }>): { [key: string]: TDescriptor } {
        const descriptors = {};
        for (const classId of registry.keys()) {
            const entry = registry.get(classId);
            descriptors[classId] = entry.descriptor;
        }
        return descriptors;
    }

    private sendSync(message: RPC_Message, channel = this.channel) {
        console.log('sendSync', message);
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
        console.log('sendAsyncIfPossible', message, channel);
        return channel.sendAsync ? this.sendAsync(message, channel) : this.sendSync(message, channel);
    }

    private addMarker(message: RPC_Message) {
        message.rpc_marker = 'webrpc';
    }

    private checkMarker(message: RPC_Message): message is RPC_Message {
        return typeof message === 'object' && message.rpc_marker === 'webrpc';
    }

    private getTargetFunction(msg: RPC_FnCallMessage | RPC_RpcCallMessage): TargetFunctionEntry {
        const entry = this.localObjectRegistry.get(msg.objId);
        if (!entry) return;

        if (msg.action === 'rpc_call') {
            return { 
                scope: entry.target, 
                target: entry.target?.[msg.prop], 
                descriptor: <FunctionDescriptor>(entry.descriptor as ObjectDescriptor).functions?.find(func => typeof func === 'object' && func.name === msg.prop) 
            };
        }
        return <TargetFunctionEntry>entry;
    }

    private callTargetFunction(msg: RPC_RpcCallMessage | RPC_FnCallMessage, replyChannel = this.channel) {
        const entry = this.getTargetFunction(msg);
        let result: any;
        let success = true;
        try {
            if (!entry) throw new Error(`No object found with ID '${msg.objId}'`);

            result = entry.target.apply(entry.scope, this.deSerializeFunctionArgs(entry.descriptor, msg.args, replyChannel));

            if (msg.callType === 'async') {
                Promise.resolve(result)
                .then(value => result = value, err => { result = err; success = false; })
                .then(() => this.sendAsync({ action: 'fn_reply', callType: 'async', success, result, callId: msg.callId }, replyChannel));
            }
        } catch (err) {
            success = false;
            result = err?.toString?.();
        }
        if (msg.callType === 'sync') {
            this.sendSync({ action: 'fn_reply', callType: 'sync', success, result }, replyChannel);
        } else if (msg.callType === 'async' && !success) {
            this.sendAsync({ action: 'fn_reply', callType: 'async', success, result, callId: msg.callId }, replyChannel);
        }
    }

    sendRemoteDescriptors(replyChannel = this.channel) {
        this.sendSyncIfPossible({ action: 'descriptors', 
            objects: this.getDescriptors(this.localObjectRegistry),
            classes: this.getDescriptors(this.classRegistry)
        }, replyChannel);
    }

    messageReceived(message: RPC_Message, replyChannel = this.channel) {
        console.log('received', JSON.stringify(message));

        if (this.checkMarker(message)) {
            switch (message.action) {
                case 'get_descriptors': {
                    this.sendRemoteDescriptors(replyChannel);
                    break;
                }
                case 'fn_call':
                case 'rpc_call': {
                    this.callTargetFunction(message, replyChannel);
                    break;
                }
                case 'obj_died': {
                    this.localObjectRegistry.delete(message.objId);
                    // console.log('objReg #', this.localObjectRegistry.size);
                    break;
                }
                case 'fn_reply': {
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

    private getPropName(descriptor: string | { name?: string }) {
        return typeof descriptor === 'string' ? descriptor : descriptor.name;
    }

    private getArgumentDescriptor(func: FunctionDescriptor, idx?: number) {
        return typeof func === 'object' ? func.arguments?.find(arg => arg.idx == null || arg.idx === idx) : undefined;
    }

    private serializeFunctionArgs(func: FunctionDescriptor, args: any[]) {
        return args.map((arg, idx) => this.preprocessSerialization(arg, this.getArgumentDescriptor(func, idx)));
    }

    private deSerializeFunctionArgs(func: FunctionDescriptor, args: any[], replyChannel: RPCChannel) {
        return args.map((arg, idx) => this.postprocessSerialization(arg, replyChannel, this.getArgumentDescriptor(func, idx)));
    }

    private createVoidProxyFunction(objId: string, func: FunctionDescriptor, action: RPC_CallAction, replyChannel: RPCChannel) {
        const fn = (...args: any[]) => {
            if (fn['rpc_disposed']) throw new Error(`Remote function has been disposed`);
            this.sendAsyncIfPossible({ action, callType: 'void', objId,
                prop: func.name, 
                args: this.serializeFunctionArgs(func, args) 
            }, replyChannel);
        };
        return fn;
    }

    private createSyncProxyFunction(objId: string, func: FunctionDescriptor, action: RPC_CallAction, replyChannel: RPCChannel) {
        const fn = (...args: any[]) => {
            if (fn['rpc_disposed']) throw new Error(`Remote function has been disposed`);
            let response = this.sendSync({ action, callType: 'sync', objId, 
                prop: func.name, 
                args: this.serializeFunctionArgs(func, args) 
            }, replyChannel);

            if (!response) throw new Error(`No response received`);
            if (typeof response !== 'object' || response.rpc_marker !== 'webrpc') throw new Error(`Invalid response ${JSON.stringify(response)}`);

            if (!response.success) throw new Error(response.result);
            return response.result;
        };
        return fn;
    }

    private createAsyncProxyFunction(objId: string, func: FunctionDescriptor, action: RPC_CallAction, replyChannel: RPCChannel) {
        const fn = (...args: any[]) => new Promise((resolve, reject) => {
            if (fn['rpc_disposed']) throw new Error(`Remote function has been disposed`);
            this.callId++;
            this.sendAsync({
                action, callType: 'async', objId, callId: this.callId,
                prop: func.name, 
                args: this.serializeFunctionArgs(func, args)
            }, replyChannel);
            this.asyncCallbacks.set(this.callId, { resolve, reject });
        });
        return fn;
    }

    private createProxyFunction(objId: string, prop: string | FunctionDescriptor, action: RPC_CallAction, 
        defaultCallType: FunctionReturnType = 'async', replyChannel = this.channel) 
    {
        const descriptor = (typeof prop === 'object') ? prop : { name: prop };

        switch (descriptor?.returns || defaultCallType) {
            case 'void': return this.createVoidProxyFunction(objId, descriptor, action, replyChannel);
            case 'sync': return this.createSyncProxyFunction(objId, descriptor, action, replyChannel);
            default: return this.createAsyncProxyFunction(objId, descriptor, action, replyChannel);
        }
    }

    createProxyObject(objId: string) {
        const descriptor = this.remoteObjectDescriptors[objId];
        if (!descriptor) {
            throw new Error(`No object registered with ID '${objId}'`);
        }

        if (typeof descriptor === 'string' || descriptor.type === 'function') {
            return this.createProxyFunction(objId, descriptor, 'fn_call');
        }

        return this.createRemoteObject(objId, descriptor);
    }

    private createRemoteObject(objId: string, descriptor: ObjectDescriptor) {
        const obj = {};

        if (descriptor.functions) for (const prop of descriptor.functions) {
            obj[this.getPropName(prop)] = this.createProxyFunction(objId, prop, 'rpc_call');
        }

        if (descriptor.proxiedProperties) for (const prop of descriptor.proxiedProperties) {
            Object.defineProperty(obj, this.getPropName(prop), {
                get: this.createProxyFunction(objId, prop, 'prop_get', 'sync'),
                set: typeof prop === 'object' && prop.readonly ? undefined : this.createProxyFunction(objId, prop, 'prop_set', 'sync')
            });
        }

        return obj;
    }

    private registerLocalObj(obj: any, descriptor: Descriptor) {
        let objId = obj._rpc_objId;
        if (!this.localObjectRegistry.has(objId)) {
            objId = nanoid();
            this.localObjectRegistry.set(objId, { target: obj, descriptor });
            obj._rpc_objId = objId;
        }
        return objId;
    }

    private preprocessSerialization(obj: any, descriptor?: Descriptor) {
        switch (typeof obj) {
            case 'object': {
                const entry = this.classRegistry.get(obj.constructor._rpc_classId);
                if (entry) {
                    const objId = this.registerLocalObj(obj, entry.descriptor);
                    const props = {};

                    if (entry.descriptor.readonlyProperties) for (const prop of entry.descriptor.readonlyProperties) {
                        const propName = this.getPropName(prop);
                        props[propName] = this.preprocessSerialization(obj[propName]);
                    }
                    return { _rpc_type: 'object', objId, classId: entry.descriptor.classId, props };
                }

                for (const key of Object.keys(obj)) {
                    obj[key] = this.preprocessSerialization(obj[key]);
                }
                break;
            }
            case 'function': {
                const objId = this.registerLocalObj(obj, descriptor);
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
                if (obj._rpc_type === 'object') {
                    const entry = this.classRegistry.get(obj.classId);
                    if (entry) {
                        const proto = this.createRemoteObject(obj.objId, entry.descriptor);
                        return Object.setPrototypeOf(obj.props, proto);
                    }
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
        let fn = this.remoteObjectRegistry.get(objId);
        if (!fn) {
            descriptor.type = 'function';
            fn = this.createProxyFunction(objId, descriptor, 'fn_call', 'async', replyChannel);
            this.remoteObjectRegistry.register(objId, fn, 
                (() => { this.sendAsyncIfPossible({ action: 'obj_died', objId }, replyChannel) }));
        }
        return fn;
    }

    private classRegistry = new Map<string, ClassRegistryEntry>();

    registerProxyClass(classId: string, classCtor: any, descriptor: ClassDescriptor) {
        descriptor.classId ??= classId;

        // statics
        if (descriptor.staticFunctions || descriptor.staticProperties) {
            this.registerTargetObject(classId, classCtor, {
                functions: descriptor.staticFunctions || [],
                proxiedProperties: descriptor.staticProperties || []
            });
        }

        classCtor._rpc_classId = classId;
        this.classRegistry.set(classId, { classCtor, descriptor });
    }


}
