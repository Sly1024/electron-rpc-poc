import { nanoid } from 'nanoid/non-secure';
import { RemoteObjectRegistry } from './remote-object-registry';
import { ArgumentDescriptor, ClassDescriptor, ClassDescriptors, Descriptor, FunctionDescriptor, FunctionReturnType, getArgumentDescriptorByIdx, getFunctionDescriptor, getPropertyDescriptor, getPropName, ObjectDescriptor, ObjectDescriptors } from './rpc-descriptor-types';
import type { RPC_AnyCallMessage, RPC_CallAction, RPC_DescriptorsResultMessage, RPC_Message } from './rpc-message-types';


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

export interface RPCChannel {
    sendSync?: (message: RPC_Message) => any,
    sendAsync?: (message: RPC_Message) => void,
    receive?: (callback: (message: any, replyChannel?: RPCChannel) => void) => void
}

export class RPCService {
    private channel: RPCChannel;

    private remoteObjectDescriptors: ObjectDescriptors;
    private remoteClassDescriptors: ClassDescriptors;
    private remoteDescriptorsCallbacks: PromiseCallbacks;

    private asyncCallbacks = new Map<number, PromiseCallbacks>();
    private callId = 0;

    private readonly remoteObjectRegistry = new RemoteObjectRegistry();
    private readonly localObjectRegistry = new Map<string, LocalObjectRegistryEntry>();
    private readonly classRegistry = new Map<string, ClassRegistryEntry>();

    connect(channel: RPCChannel) {
        this.channel = channel;
        channel.receive?.(this.messageReceived.bind(this));
    }

    registerTargetObject(objId: string, target: object|Function, descriptor: Descriptor) {
        descriptor.type = <'object'|'function'>typeof target;
        this.localObjectRegistry.set(objId, { target, descriptor });
    }
 
    requestRemoteDescriptors() {
        if (this.channel.sendSync) {
            const response = this.sendSync({ action: 'get_descriptors' }) as RPC_DescriptorsResultMessage;
            return this.setRemoteDescriptors(response);
        }

        return new Promise<void>((resolve, reject) => {
            this.sendAsync({ action: 'get_descriptors' });
            this.remoteDescriptorsCallbacks = { resolve, reject };
        });
    }

    private setRemoteDescriptors(response: RPC_DescriptorsResultMessage) {
        if (typeof response === 'object' && response.objects && response.classes) {
            this.remoteObjectDescriptors = response.objects;
            this.remoteClassDescriptors = response.classes;
            return true;
        }
        return false;
    }

    sendRemoteDescriptors(replyChannel = this.channel) {
        this.sendSyncIfPossible({
            action: 'descriptors',
            objects: this.getDescriptors(this.localObjectRegistry),
            classes: this.getDescriptors(this.classRegistry)
        }, replyChannel);
    }

    private getDescriptors<TDescriptor>(registry: Map<string, { descriptor: TDescriptor }>): { [key: string]: TDescriptor } {
        const descriptors = {};
        for (const key of registry.keys()) {
            const entry = registry.get(key);
            descriptors[key] = entry.descriptor;
        }
        return descriptors;
    }

    private sendSync(message: RPC_Message, channel = this.channel) {
        console.log('sendSync', message);
        
        this.addMarker(message);
        return channel.sendSync?.(message);
    }

    private sendAsync(message: RPC_Message, channel = this.channel) {
        console.log('sendAsync', message);
        
        this.addMarker(message);
        channel.sendAsync?.(message);
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

    private callTargetFunction(msg: RPC_AnyCallMessage, replyChannel = this.channel) {
        let entry = this.localObjectRegistry.get(msg.objId);
        let result: any;
        let success = true;
        try {
            if (!entry) throw new Error(`No object found with ID '${msg.objId}'`);
            let scope: object = null;
            let { descriptor, target } = entry;

            switch (msg.action) {
                case 'prop_get': {
                    result = target[msg.prop];
                    break;
                }
                case 'prop_set': {
                    const descr = getPropertyDescriptor(descriptor as ObjectDescriptor, msg.prop);
                    target[msg.prop] = this.postprocessSerialization(msg.args[0], replyChannel, descr.argument);
                    break;
                }
                case 'mthd_call': {
                    scope = target;
                    descriptor = getFunctionDescriptor(entry.descriptor as ObjectDescriptor, msg.prop);
                    target = target[msg.prop];
                    // NO break here!
                }
                case 'fn_call': {
                    result = target.apply(scope, this.deserializeFunctionArgs(descriptor as FunctionDescriptor, msg.args, replyChannel));
                    break;
                }
            }

            result = this.preprocessSerialization(result);

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

    messageReceived(message: RPC_Message, replyChannel = this.channel) {
        console.log('received', JSON.stringify(message));

        if (this.checkMarker(message)) {
            switch (message.action) {
                case 'get_descriptors': {
                    this.sendRemoteDescriptors(replyChannel);
                    break;
                }
                case 'descriptors': {
                    this.remoteDescriptorsCallbacks[this.setRemoteDescriptors(message) ? 'resolve' : 'reject']();
                    break;
                }
                case 'prop_get':
                case 'prop_set':
                case 'fn_call':
                case 'mthd_call': {
                    this.callTargetFunction(message, replyChannel);
                    break;
                }
                case 'obj_died': {
                    this.localObjectRegistry.delete(message.objId);
                    console.log('objReg #', this.localObjectRegistry.size);
                    break;
                }
                case 'fn_reply': {
                    if (message.callType === 'async') {
                        const result = this.postprocessSerialization(message.result, replyChannel);
                        const callbacks = this.asyncCallbacks.get(message.callId);
                        callbacks[message.success ? 'resolve' : 'reject'](result);
                        this.asyncCallbacks.delete(message.callId);
                    }
                    break;
                }
            }
        }
    }


    private serializeFunctionArgs(func: FunctionDescriptor, args: any[]) {
        return args.map((arg, idx) => this.preprocessSerialization(arg, getArgumentDescriptorByIdx(func, idx)));
    }

    private deserializeFunctionArgs(func: FunctionDescriptor, args: any[], replyChannel: RPCChannel) {
        return args.map((arg, idx) => this.postprocessSerialization(arg, replyChannel, getArgumentDescriptorByIdx(func, idx)));
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
            return this.postprocessSerialization(response.result, replyChannel);
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

    createProxyClass(classId: string) {
        const descriptor = this.remoteClassDescriptors[classId];
        if (!descriptor) {
            throw new Error(`No class registered with ID '${classId}'`);
        }

        const clazz = function () {};
        this.createRemoteObject(classId, {
            functions: descriptor.staticFunctions,
            proxiedProperties: descriptor.staticProperties
        }, clazz);

        return clazz;
    }

    private createRemoteObject(objId: string, descriptor: ObjectDescriptor, obj = {}) {
        if (descriptor.functions) for (const prop of descriptor.functions) {
            obj[getPropName(prop)] = this.createProxyFunction(objId, prop, 'mthd_call');
        }

        if (descriptor.proxiedProperties) for (const prop of descriptor.proxiedProperties) {
            Object.defineProperty(obj, getPropName(prop), {
                get: this.createProxyFunction(objId, prop, 'prop_get', 'sync'),
                set: typeof prop === 'object' && prop.readonly ? undefined : this.createProxyFunction(objId, prop, 'prop_set', 'sync')
            });
        }

        return obj;
    }

    private createRemoteInstance(objId: string, classId: string, props: any) {
        if (this.remoteObjectRegistry.has(objId)) return this.remoteObjectRegistry.get(objId);
        
        const descriptor = this.remoteClassDescriptors[classId];
        if (descriptor) {
            const proto = this.createRemoteObject(objId, descriptor);
            this.remoteObjectRegistry.register(objId, props, () => this.sendObjectDied(objId));
            return Object.setPrototypeOf(props, proto);
        }
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
                        const propName = getPropName(prop);
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

    private postprocessSerialization(obj: any, replyChannel: RPCChannel, descriptor?: ArgumentDescriptor) {
        switch (typeof obj) {
            case 'object': {
                if (obj._rpc_type === 'function') {
                    return this.createRemoteFunction(obj.objId, replyChannel, descriptor);
                }
                if (obj._rpc_type === 'object') {
                    const remoteInstance = this.createRemoteInstance(obj.objId, obj.classId, obj.props);
                    if (remoteInstance) return remoteInstance;
                }
                for (const key of Object.keys(obj)) {
                    obj[key] = this.postprocessSerialization(obj[key], replyChannel);
                }
                break;
            }
        }
        return obj;
    }

    private sendObjectDied(objId: string, replyChannel = this.channel) {
        this.sendAsyncIfPossible({ action: 'obj_died', objId }, replyChannel);
    }

    private createRemoteFunction(objId: string, replyChannel: RPCChannel, descriptor?: FunctionDescriptor) {
        let fn = this.remoteObjectRegistry.get(objId);
        if (!fn) {
            if (descriptor) descriptor.type = 'function';
            fn = this.createProxyFunction(objId, descriptor, 'fn_call', 'async', replyChannel);
            this.remoteObjectRegistry.register(objId, fn, () => this.sendObjectDied(objId));
        }
        return fn;
    }

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
