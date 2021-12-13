import { nanoid } from 'nanoid/non-secure';
import { RemoteObjectRegistry } from './remote-object-registry';
import {
    ClassDescriptor,
    ClassDescriptors,
    Descriptor,
    FunctionDescriptor,
    FunctionReturnType,
    getArgumentDescriptor,
    getFunctionDescriptor,
    getPropertyDescriptor,
    getPropName,
    ObjectDescriptor,
    ObjectDescriptors
} from './rpc-descriptor-types';
import type {
    RPC_AnyCallMessage, RPC_AsyncCallAction, RPC_CallAction, RPC_DescriptorsResultMessage, RPC_Message, RPC_SyncCallAction, RPC_VoidCallAction
} from './rpc-message-types';


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
    descriptor: FunctionDescriptor | ObjectDescriptor;
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

    private asyncCallbacks = new Map<number|string, PromiseCallbacks>();
    private callId = 0;

    private readonly remoteObjectRegistry = new RemoteObjectRegistry();
    private readonly localObjectRegistry = new Map<string, LocalObjectRegistryEntry>();
    private readonly localClassRegistry = new Map<string, ClassRegistryEntry>();
    private readonly remoteClassRegistry = new Map<string, Function>();

    connect(channel: RPCChannel) {
        this.channel = channel;
        channel.receive?.(this.messageReceived.bind(this));
    }

    registerTargetObject(objId: string, target: object|Function, descriptor: ObjectDescriptor | FunctionDescriptor) {
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
            classes: this.getDescriptors(this.localClassRegistry)
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
                    target[msg.prop] = this.postprocessSerialization(msg.args[0], replyChannel, descr?.get?.arguments?.[0]);
                    break;
                }
                case 'method_call': {
                    scope = target;
                    descriptor = getFunctionDescriptor(entry.descriptor as ObjectDescriptor, msg.prop);
                    target = target[msg.prop];
                    if (typeof target !== 'function') throw new Error(`Property ${msg.prop} is not a function on object ${msg.objId}`);
                    // NO break here!
                }
                case 'fn_call': {
                    result = target.apply(scope, this.deserializeFunctionArgs(descriptor as FunctionDescriptor, msg.args, replyChannel));
                    break;
                }
                case 'ctor_call': {
                    result = new target(...this.deserializeFunctionArgs(descriptor as FunctionDescriptor, msg.args, replyChannel));
                    break;
                }
            }

            result = this.preprocessSerialization(result, replyChannel);

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
                case 'ctor_call':
                case 'fn_call':
                case 'method_call': {
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


    private serializeFunctionArgs(func: FunctionDescriptor, args: any[], replyChannel: RPCChannel) {
        return args.map((arg, idx) => this.preprocessSerialization(arg, replyChannel, getArgumentDescriptor(func, idx)));
    }

    private deserializeFunctionArgs(func: FunctionDescriptor, args: any[], replyChannel: RPCChannel) {
        return args.map((arg, idx) => this.postprocessSerialization(arg, replyChannel, getArgumentDescriptor(func, idx)));
    }

    private createVoidProxyFunction(objId: string, func: FunctionDescriptor, action: RPC_VoidCallAction, replyChannel: RPCChannel) {
        const _this = this;
        const fn = function (...args: any[]) {
            if (fn['rpc_disposed']) throw new Error(`Remote function has been disposed`);
            _this.sendAsyncIfPossible({ action, callType: 'void', 
                objId: objId ?? this._rpc_objId,
                prop: func.name, 
                args: _this.serializeFunctionArgs(func, args, replyChannel) 
            });
        };
        return fn;
    }

    private createSyncProxyFunction(objId: string, func: FunctionDescriptor, action: RPC_SyncCallAction, replyChannel: RPCChannel) {
        const _this = this;
        const fn = function (...args: any[]) {
            if (fn['rpc_disposed']) throw new Error(`Remote function has been disposed`);
            let response = _this.sendSync({ action, callType: 'sync', 
                objId: objId ?? this._rpc_objId,
                prop: func.name, 
                args: _this.serializeFunctionArgs(func, args, replyChannel) 
            }, replyChannel);

            if (!response) throw new Error(`No response received`);
            if (typeof response !== 'object' || response.rpc_marker !== 'webrpc') throw new Error(`Invalid response ${JSON.stringify(response)}`);

            if (!response.success) throw new Error(response.result);
            return _this.postprocessSerialization(response.result, replyChannel);
        };
        return fn;
    }

    private createAsyncProxyFunction(objId: string, func: FunctionDescriptor, action: RPC_AsyncCallAction, replyChannel: RPCChannel) {
        const _this = this;
        const fn = function (...args: any[]) {
            return new Promise((resolve, reject) => {
                if (fn['rpc_disposed']) throw new Error(`Remote function has been disposed`);
                _this.callId++;
                _this.sendAsync({
                    action, callType: 'async',
                    objId: objId ?? this._rpc_objId,
                    callId: _this.callId,
                    prop: func.name, 
                    args: _this.serializeFunctionArgs(func, args, replyChannel)
                }, replyChannel);
                _this.asyncCallbacks.set(_this.callId, { resolve, reject });
            });
        };
        return fn;
    }

    private createProxyFunction(objId: string, prop: string | FunctionDescriptor, action: RPC_CallAction, 
        defaultCallType: FunctionReturnType = 'async', replyChannel = this.channel) 
    {
        const descriptor = (typeof prop === 'object') ? prop : { name: prop };

        switch (descriptor?.returns || defaultCallType) {
            case 'void': return this.createVoidProxyFunction(objId, descriptor, <RPC_VoidCallAction>action, replyChannel);
            case 'sync': return this.createSyncProxyFunction(objId, descriptor, <RPC_SyncCallAction>action, replyChannel);
            default: return this.createAsyncProxyFunction(objId, descriptor, <RPC_AsyncCallAction>action, replyChannel);
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
        if (this.remoteClassRegistry.has(classId)) return this.remoteClassRegistry.get(classId);

        const descriptor = this.remoteClassDescriptors?.[classId];
        if (!descriptor) {
            throw new Error(`No class registered with ID '${classId}'`);
        }

        const clazz = descriptor.ctor ? this.createProxyFunction(classId + '.ctor', descriptor.ctor, 'ctor_call', 'sync') 
            : function () { throw new Error(`Constructor of class '${classId}' is not defined`); };

        this.createRemoteObject(null, descriptor, clazz.prototype);

        // add static functions/props
        this.createRemoteObject(classId, {
            functions: descriptor.staticFunctions,
            proxiedProperties: descriptor.staticProperties
        }, clazz);

        this.remoteClassRegistry.set(classId, clazz);

        return clazz;
    }

    private createRemoteObject(objId: string, descriptor: ObjectDescriptor, obj = {}) {
        if (descriptor.functions) for (const prop of descriptor.functions) {
            obj[getPropName(prop)] = this.createProxyFunction(objId, prop, 'method_call');
        }

        if (descriptor.proxiedProperties) for (const prop of descriptor.proxiedProperties) {
            const descr = typeof prop === 'string' ? { name: prop } : prop;
            Object.defineProperty(obj, descr.name, {
                get: this.createProxyFunction(objId, { ...descr.get, name: descr.name }, 'prop_get', 'sync'),
                set: descr.readonly ? undefined : this.createProxyFunction(objId, { ...descr.set, name: descr.name }, 'prop_set', 'void')
            });
        }

        return obj;
    }

    private createRemoteInstance(objId: string, classId: string, props: any, replyChannel: RPCChannel) {
        if (this.remoteObjectRegistry.has(objId)) return this.remoteObjectRegistry.get(objId);
        
        let obj: any = props || {};

        // special case for Promise
        if (classId === 'Promise') {
            obj = new Promise((resolve, reject) => this.asyncCallbacks.set(objId, { resolve, reject }));
        } else {
            obj._rpc_objId = objId;
            const clazz = this.createProxyClass(classId);
            Object.setPrototypeOf(obj, clazz.prototype);
        }

        this.remoteObjectRegistry.register(objId, obj, () => this.sendObjectDied(objId, replyChannel));
        return obj;
    }

    private registerLocalObj(obj: any, descriptor: FunctionDescriptor | ObjectDescriptor) {
        let objId = obj._rpc_objId;
        if (!this.localObjectRegistry.has(objId)) {
            objId = nanoid();
            this.localObjectRegistry.set(objId, { target: obj, descriptor });
            obj._rpc_objId = objId;
        }
        return objId;
    }

    private preprocessSerialization(obj: any, replyChannel: RPCChannel, descriptor?: Descriptor) {
        switch (typeof obj) {
            case 'object': {
                // special case for Promise
                if (obj.constructor === Promise) {
                    if (!this.localObjectRegistry.has(obj['_rpc_objId'])) {
                        let result: any;
                        let success: boolean;
                        obj.then(
                            (value) => { result = value; success = true },
                            (value) => { result = value; success = false }
                        ).finally(() => this.sendAsyncIfPossible({ action: 'fn_reply', callType: 'async', success, result, callId: objId }, replyChannel));
                    }
                    const objId = this.registerLocalObj(obj, {});
                    return { _rpc_type: 'object', objId, classId: 'Promise' };
                }

                const entry = this.localClassRegistry.get(obj.constructor._rpc_classId);
                if (entry) {
                    const objId = this.registerLocalObj(obj, entry.descriptor);
                    const props = {};

                    if (entry.descriptor.readonlyProperties) for (const prop of entry.descriptor.readonlyProperties) {
                        const propName = getPropName(prop);
                        props[propName] = this.preprocessSerialization(obj[propName], replyChannel);
                    }

                    return { _rpc_type: 'object', objId, classId: entry.descriptor.classId, props };
                }

                for (const key of Object.keys(obj)) {
                    obj[key] = this.preprocessSerialization(obj[key], replyChannel);
                }
                break;
            }
            case 'function': {
                const objId = this.registerLocalObj(obj, <FunctionDescriptor>descriptor);
                return { _rpc_type: 'function', objId };
            }
        }
        return obj;
    }

    private postprocessSerialization(obj: any, replyChannel: RPCChannel, descriptor?: Descriptor) {
        if (typeof obj !== 'object') return obj;

        switch (obj._rpc_type) {
            case 'object': {
                return this.createRemoteInstance(obj.objId, obj.classId, obj.props, replyChannel);
            }
            case 'function': {
                return this.createRemoteFunction(obj.objId, replyChannel, <FunctionDescriptor>descriptor);
            }
        }

        for (const key of Object.keys(obj)) {
            obj[key] = this.postprocessSerialization(obj[key], replyChannel, getPropertyDescriptor(<ObjectDescriptor>descriptor, key));
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
            this.remoteObjectRegistry.register(objId, fn, () => this.sendObjectDied(objId, replyChannel));
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
        this.localClassRegistry.set(classId, { classCtor, descriptor });
        
        if (descriptor.ctor) {
            this.registerTargetObject(classId + '.ctor', classCtor, descriptor.ctor);
        }
    }


}
