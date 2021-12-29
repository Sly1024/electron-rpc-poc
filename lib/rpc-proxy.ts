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
    ObjectDescriptorWithProps,
    ObjectDescriptors
} from './rpc-descriptor-types';
import type {
    RPC_AnyCallMessage, RPC_AsyncCallAction, RPC_AnyCallAction, RPC_DescriptorsResultMessage, RPC_Message, RPC_SyncCallAction, RPC_VoidCallAction
} from './rpc-message-types';


type PromiseCallbacks = {
    resolve: (data?: any) => void;
    reject: (data?: any) => void;
};

type AnyConstructor = new (...args: any[]) => unknown;
type AnyFunction = (...args: any[]) => any;

type ClassRegistryEntry = {
    descriptor: ClassDescriptor;
    classCtor: AnyConstructor;
};

type LocalObjectRegistryEntry = {
    target: any;
    descriptor: FunctionDescriptor | ObjectDescriptor;
};

/**
 * The channel used for the communication.
 * Can support synchronous and/or asynchronous messages.
 * 
 * Note: if sync/async is not supported, make sure to use the correct return type for functions: [[FunctionReturnType]].
 */
export interface RPCChannel {
    /**
     * Sends a message and returns the response synchronously.
     */
    sendSync?: (message: RPC_Message) => any;

    /**
     * Sends a message asnychronously. The response will come via the `receive` callback function.
     */
    sendAsync?: (message: RPC_Message) => void;

    /**
     * Register a callback for when an async message arrives.
     */
    receive?: (callback: (message: RPC_Message, replyChannel?: RPCChannel) => void) => void;
}

/**
 * The RPCService is the central piece. An instance must be created on both sides.
 * 
 * Objects, functions or classes can be registered on the "host" side 
 * (see [[registerHostObject]], [[registerHostClass]]) and then functions/properties can be
 * called from the "client" side (see [[createProxyObject]], [[getOrCreateProxyClass]]).
 * 
 * The RPC service is symmetric, so depending on the use-case (and the channel), 
 * both side can be "host" and "client" at the same time.
 * 
 * The constructor needs a function to generate unique IDs for objects. 
 * In order to have no dependencies this needs to be passed in.
 * For convenience the examples use [nanoid](https://www.npmjs.com/package/nanoid).
 */
export class RPCService {
    private channel!: RPCChannel;

    private remoteObjectDescriptors?: ObjectDescriptors;
    private remoteClassDescriptors?: ClassDescriptors;
    private remoteDescriptorsCallbacks?: PromiseCallbacks;

    private asyncCallbacks = new Map<number|string, PromiseCallbacks>();
    private callId = 0;

    private readonly remoteObjectRegistry = new RemoteObjectRegistry();
    private readonly remoteClassRegistry = new Map<string, AnyFunction>();
    private readonly localObjectRegistry = new Map<string, LocalObjectRegistryEntry>();
    private readonly localClassRegistry = new Map<string, ClassRegistryEntry>();

    /**
     * 
     * @param objectIdGenerator A function to generate a unique ID for an object 
     * when a remote object needs to be identified by an ID.
     */
    constructor(private objectIdGenerator: () => string) {
    }

    /**
     * Connect the service to a channel.
     */
    connect(channel: RPCChannel) {
        this.channel = channel;
        channel.receive?.(this.messageReceived.bind(this));
    }

    /**
     * Register an object (or function) in the service to be called remotely. 
     * @param objId An ID that the "client" side uses to identify this object.
     * @param target The target object/function
     * @param descriptor Describes:
     *  - for objects: which functions/properties to expose
     *  - for functions: arguments and return behavior ([[FunctionReturnType]])
     */
    registerHostObject<T extends object|AnyFunction|AnyConstructor>(objId: string, target: T, 
        descriptor: T extends AnyFunction ? FunctionDescriptor : 
                    T extends AnyConstructor ? (ObjectDescriptor|FunctionDescriptor) 
                    : ObjectDescriptor)
    {
        descriptor.type = <T extends AnyFunction ? 'function' : 'object'>typeof target;
        this.localObjectRegistry.set(objId, { target, descriptor });
    }
 
    /**
     * Register a class in the service. 
     * 
     * When an instance of this class is passed to the other side, only the "readonlyProperties" are sent (see [[ClassDescriptor]]).
     * Functions and proxied properties are generated there and those call back to the original object.
     * 
     * Even the constructor can be proxied.
     * 
     * Note: static functions/properties act as if the class was a normal host object.
     * 
     * @param classId An ID to identify the class on the client side.
     * @param classCtor The class itself (its constructor function)
     * @param descriptor What properties/functions to expose
     */
    registerHostClass(classId: string, classCtor: AnyConstructor, descriptor: ClassDescriptor) {
        descriptor.classId = classId;

        // statics
        if (descriptor.staticFunctions || descriptor.staticProxiedProperties || descriptor.staticReadonlyProperties) {
            this.registerHostObject(classId, classCtor, {
                functions: descriptor.staticFunctions || [],
                proxiedProperties: descriptor.staticProxiedProperties || [],
                readonlyProperties: descriptor.staticReadonlyProperties || []
            });
        }

        (classCtor as any)._rpc_classId = classId;
        this.localClassRegistry.set(classId, { classCtor, descriptor });
        
        if (descriptor.ctor) {
            this.registerHostObject(classId + '.ctor', classCtor, descriptor.ctor);
        }
    }

    requestRemoteDescriptors() {
        if (this.channel?.sendSync) {
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
            objects: this.getLocalDescriptors(this.localObjectRegistry),
            classes: this.getLocalDescriptors(this.localClassRegistry),
        }, replyChannel);
    }

    private getLocalDescriptors<T extends LocalObjectRegistryEntry|ClassRegistryEntry>(registry: Map<string, T>): 
        T extends LocalObjectRegistryEntry ? ObjectDescriptors : ClassDescriptors 
    {
        const descriptors: any = {};
        for (const key of registry.keys()) {
            // .get() could return undefined, but we know it will never do that, since we iterate over existing keys
            // therefore it is safe to cast it to the entry types
            const entry = <ClassRegistryEntry|LocalObjectRegistryEntry>registry.get(key);

            if (entry.descriptor.type === 'object' && entry.descriptor.readonlyProperties) {
                const props: any = {};
                for (const prop of entry.descriptor.readonlyProperties) {
                    props[prop] = (entry as LocalObjectRegistryEntry).target[prop];
                }
                descriptors[key] = { props, ...entry.descriptor };
            } else {
                descriptors[key] = entry.descriptor;
            }
        }
        return descriptors;
    }

    private sendSync(message: RPC_Message, channel = this.channel) {
        console.log('sendSync', message);
        
        this.addMarker(message);
        return channel?.sendSync?.(message);
    }

    private sendAsync(message: RPC_Message, channel = this.channel) {
        console.log('sendAsync', message);
        
        this.addMarker(message);
        channel?.sendAsync?.(message);
    }

    private sendSyncIfPossible(message: RPC_Message, channel = this.channel) {
        return channel?.sendSync ? this.sendSync(message, channel) : this.sendAsync(message, channel);
    }

    private sendAsyncIfPossible(message: RPC_Message, channel = this.channel) {
        return channel?.sendAsync ? this.sendAsync(message, channel) : this.sendSync(message, channel);
    }

    private addMarker(message: RPC_Message) {
        message.rpc_marker = 'srpc';
    }

    private checkMarker(message: RPC_Message): message is RPC_Message {
        return typeof message === 'object' && message.rpc_marker === 'srpc';
    }

    private callTargetFunction(msg: RPC_AnyCallMessage, replyChannel = this.channel) {
        const entry = this.localObjectRegistry.get(msg.objId);
        let result: any;
        let success = true;
        try {
            if (!entry) throw new Error(`No object found with ID '${msg.objId}'`);
            let scope: unknown = null;
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
                // eslint-disable-next-line no-fallthrough
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
        } catch (err: any) {
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
                    this.remoteDescriptorsCallbacks?.[this.setRemoteDescriptors(message) ? 'resolve' : 'reject']();
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
                        callbacks?.[message.success ? 'resolve' : 'reject'](result);
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

    private createVoidProxyFunction(objId: string|null, func: FunctionDescriptor, action: RPC_VoidCallAction, replyChannel: RPCChannel) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const _this = this;
        const fn = function (this: any, ...args: any[]) {
            if ((fn as any)['rpc_disposed']) throw new Error(`Remote function has been disposed`);
            _this.sendAsyncIfPossible({ action, callType: 'void', 
                objId: objId ?? this._rpc_objId,
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                prop: func.name!, 
                args: _this.serializeFunctionArgs(func, args, replyChannel) 
            }, replyChannel);
        };
        return fn;
    }

    private createSyncProxyFunction(objId: string|null, func: FunctionDescriptor, action: RPC_SyncCallAction, replyChannel: RPCChannel) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const _this = this;
        const fn = function (this: any, ...args: any[]) {
            if ((fn as any)['rpc_disposed']) throw new Error(`Remote function has been disposed`);
            const response = _this.sendSync({ action, callType: 'sync', 
                objId: objId ?? this._rpc_objId,
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                prop: func.name!, 
                args: _this.serializeFunctionArgs(func, args, replyChannel) 
            }, replyChannel);

            if (!response) throw new Error(`No response received`);
            if (typeof response !== 'object' || response.rpc_marker !== 'webrpc') throw new Error(`Invalid response ${JSON.stringify(response)}`);

            if (!response.success) throw new Error(response.result);
            return _this.postprocessSerialization(response.result, replyChannel);
        };
        return fn;
    }

    private createAsyncProxyFunction(objId: string|null, func: FunctionDescriptor, action: RPC_AsyncCallAction, replyChannel: RPCChannel) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const _this = this;
        const fn = function (this: any, ...args: any[]) {
            return new Promise((resolve, reject) => {
                if ((fn as any)['rpc_disposed']) throw new Error(`Remote function has been disposed`);
                _this.callId++;
                _this.sendAsync({
                    action, callType: 'async',
                    objId: objId ?? this._rpc_objId,
                    callId: _this.callId,
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    prop: func.name!, 
                    args: _this.serializeFunctionArgs(func, args, replyChannel)
                }, replyChannel);
                _this.asyncCallbacks.set(_this.callId, { resolve, reject });
            });
        };
        return fn;
    }

    private createProxyFunction(objId: string|null, prop: string | FunctionDescriptor, action: RPC_AnyCallAction, 
        defaultCallType: FunctionReturnType = 'async', replyChannel = this.channel) 
    {
        const descriptor = (typeof prop === 'object') ? prop : { name: prop };

        switch (descriptor?.returns || defaultCallType) {
            case 'void': return this.createVoidProxyFunction(objId, descriptor, <RPC_VoidCallAction>action, replyChannel);
            case 'sync': return this.createSyncProxyFunction(objId, descriptor, <RPC_SyncCallAction>action, replyChannel);
            default: return this.createAsyncProxyFunction(objId, descriptor, <RPC_AsyncCallAction>action, replyChannel);
        }
    }

    getProxyObject(objId: string) {
        let obj: any = this.remoteObjectRegistry.get(objId);
        if (obj) return obj;

        const descriptor = this.remoteObjectDescriptors?.[objId];
        if (!descriptor) {
            throw new Error(`No object registered with ID '${objId}'`);
        }

        if (typeof descriptor === 'string' || descriptor.type === 'function') {
            obj = this.createProxyFunction(objId, descriptor, 'fn_call');
        } else {
            obj = this.createProxyObject(objId, descriptor as ObjectDescriptorWithProps);
        }

        this.remoteObjectRegistry.register(objId, obj);
        return obj;
    }

    getProxyClass(classId: string) {
        let clazz = this.remoteClassRegistry.get(classId);
        if (clazz) return clazz;

        const descriptor = this.remoteClassDescriptors?.[classId];
        if (!descriptor) {
            throw new Error(`No class registered with ID '${classId}'`);
        }

        clazz = descriptor.ctor ? this.createProxyFunction(classId + '.ctor', descriptor.ctor, 'ctor_call', 'sync') 
            : function () { throw new Error(`Constructor of class '${classId}' is not defined`); };

        this.createProxyObject(null, descriptor, clazz.prototype);

        // add static functions/props
        this.createProxyObject(classId, {
            functions: descriptor.staticFunctions,
            proxiedProperties: descriptor.staticProxiedProperties,
            readonlyProperties: descriptor.staticReadonlyProperties
        }, clazz);

        this.remoteClassRegistry.set(classId, clazz);

        return clazz;
    }

    private createProxyObject(objId: string|null, descriptor: ObjectDescriptorWithProps, obj: any = { ...descriptor.props }) {
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

    private registerLocalObj(obj: any, descriptor: FunctionDescriptor | ObjectDescriptor) {
        let objId = obj._rpc_objId;
        if (!this.localObjectRegistry.has(objId)) {
            objId = this.objectIdGenerator();
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
                    if (!this.localObjectRegistry.has((obj as any)['_rpc_objId'])) {
                        let result: unknown;
                        let success: boolean;
                        obj.then(
                            (value) => { result = value; success = true },
                            (value) => { result = value; success = false }
                        ).finally(() => this.sendAsyncIfPossible({ action: 'fn_reply', callType: 'async', success, result, callId: objId }, replyChannel));
                    }
                    const objId = this.registerLocalObj(obj, {});
                    return { _rpc_type: 'object', props: { _rpc_objId: objId }, classId: 'Promise' };
                }

                const entry = this.localClassRegistry.get(obj.constructor._rpc_classId);
                if (entry) {
                    const objId = this.registerLocalObj(obj, entry.descriptor);
                    const props: any = { _rpc_objId: objId };

                    if (entry.descriptor.readonlyProperties) for (const prop of entry.descriptor.readonlyProperties) {
                        const propName = getPropName(prop);
                        props[propName] = this.preprocessSerialization(obj[propName], replyChannel);
                    }

                    return { _rpc_type: 'object', classId: entry.descriptor.classId, props };
                }

                for (const key of Object.keys(obj)) {
                    obj[key] = this.preprocessSerialization(obj[key], replyChannel);
                }
                break;
            }
            case 'function': {
                const objId = this.registerLocalObj(obj, descriptor as FunctionDescriptor);
                return { _rpc_type: 'function', objId };
            }
        }
        return obj;
    }

    private postprocessSerialization(obj: any, replyChannel: RPCChannel, descriptor?: Descriptor) {
        if (typeof obj !== 'object') return obj;

        switch (obj._rpc_type) {
            case 'object': {
                return this.getOrCreateRemoteInstance(obj.classId, obj.props, replyChannel);
            }
            case 'function': {
                return this.getOrCreateRemoteFunction(obj.objId, replyChannel, descriptor as FunctionDescriptor);
            }
        }

        for (const key of Object.keys(obj)) {
            obj[key] = this.postprocessSerialization(obj[key], replyChannel, getPropertyDescriptor(descriptor as ObjectDescriptor, key));
        }

        return obj;
    }

    private sendObjectDied(objId: string, replyChannel = this.channel) {
        this.sendAsyncIfPossible({ action: 'obj_died', objId }, replyChannel);
    }

    private getOrCreateRemoteInstance(classId: string, props: any, replyChannel: RPCChannel) {
        const objId = props._rpc_objId;
        let obj = this.remoteObjectRegistry.get(objId);
        if (obj) return obj;
        
        obj = props || {};

        // special case for Promise
        if (classId === 'Promise') {
            obj = new Promise((resolve, reject) => this.asyncCallbacks.set(objId, { resolve, reject }));
        } else {
            obj._rpc_objId = objId;
            const clazz = this.getProxyClass(classId);
            Object.setPrototypeOf(obj, clazz.prototype);
        }

        this.remoteObjectRegistry.register(objId, obj, () => this.sendObjectDied(objId, replyChannel));
        return obj;
    }

    private getOrCreateRemoteFunction(objId: string, replyChannel: RPCChannel, descriptor?: FunctionDescriptor) {
        let fn = this.remoteObjectRegistry.get(objId);
        if (!fn) {
            if (descriptor) descriptor.type = 'function';
            fn = this.createProxyFunction(objId, <any>descriptor, 'fn_call', 'async', replyChannel);
            this.remoteObjectRegistry.register(objId, fn, () => this.sendObjectDied(objId, replyChannel));
        }
        return fn;
    }


}
