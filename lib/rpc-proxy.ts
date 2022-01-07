import { ProxyObjectRegistry } from './proxy-object-registry';
import {
    ClassDescriptor, ClassDescriptors, Descriptor,
    FunctionDescriptor, FunctionReturnBehavior,
    getArgumentDescriptor, getFunctionDescriptor, getPropertyDescriptor, getPropName,
    isFunctionDescriptor, ObjectDescriptor, ObjectDescriptors, ObjectDescriptorWithProps
} from './rpc-descriptor-types';
import type {
    RPC_AnyCallAction, RPC_AnyCallMessage,
    RPC_AsyncCallAction, RPC_DescriptorsResultMessage,
    RPC_Message, RPC_SyncCallAction, RPC_VoidCallAction
} from './rpc-message-types';


type PromiseCallbacks = {
    resolve: (data?: any) => void;
    reject: (data?: any) => void;
};

export type AnyConstructor = new (...args: any[]) => unknown;
export type AnyFunction = ((...args: any[]) => any) | AnyConstructor;

type ClassRegistryEntry = {
    descriptor: ClassDescriptor;
    classCtor: AnyConstructor;
};

type HostObjectRegistryEntry = {
    target: any;
    descriptor: FunctionDescriptor | ObjectDescriptor;
};

/**
 * The channel used for the communication.
 * Can support synchronous and/or asynchronous messages.
 * 
 * Note: if sync/async is not supported, make sure to use the correct return type for functions: [[FunctionReturnBehavior]].
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
 * called from the "client" side (see [[getProxyObject]], [[getProxyClass]]).
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

    private readonly proxyObjectRegistry = new ProxyObjectRegistry();
    private readonly proxyClassRegistry = new Map<string, AnyFunction>();
    private readonly hostObjectRegistry = new Map<string, HostObjectRegistryEntry>();
    private readonly hostClassRegistry = new Map<string, ClassRegistryEntry>();

    /**
     * @param objectIdGenerator A function to generate a unique ID for an object.
     * 
     * When sending an object to the other side that can not be serialized, we 
     * generate an ID and send that instead. The other side creates a proxy object
     * that represents the remote object.
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
     * Register an object in the service to be called remotely. 
     * @param objId An ID that the "client" side uses to identify this object.
     * @param target The target object
     * @param descriptor Describes which functions/properties to expose
     */
    registerHostObject(objId: string, target: object, descriptor: ObjectDescriptor) {
        descriptor.type = 'object';
        this.hostObjectRegistry.set(objId, { target, descriptor });
    }

    /**
     * Register a function in the service to be called remotely. 
     * @param objId An ID that the "client" side uses to identify this function.
     * @param target The target function
     * @param descriptor Describes arguments and return behavior ([[FunctionReturnBehavior]])
     */
    registerHostFunction(objId: string, target: AnyFunction, descriptor: FunctionDescriptor) {
        descriptor.type = 'function';
        this.hostObjectRegistry.set(objId, { target, descriptor });
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
        descriptor.type = 'class';
        descriptor.classId = classId;

        if (descriptor.static) {
            this.registerHostObject(classId, classCtor, descriptor.static);
        }

        if (descriptor.ctor) {
            this.registerHostFunction(classId + '.ctor', classCtor, descriptor.ctor);
        }
        
        (classCtor as any)._rpc_classId = classId;
        this.hostClassRegistry.set(classId, { classCtor, descriptor });
    }

    /**
     * Send a request to get the descriptors for the registered host objects from the other side.
     * Uses synchronous communication if possible and returns `true`/`false` based on if the descriptors were received.
     * If sync is not available, it uses async messaging and returns a Promise.
     */
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

    /**
     * Send the descriptors for the registered host objects to the other side.
     * If possible, the message is sent synchronously.
     * This is a "push" style message, for "pull" see [[requestRemoteDescriptors]].
     */
    sendRemoteDescriptors(replyChannel = this.channel) {
        this.sendSyncIfPossible({
            action: 'descriptors',
            objects: this.getLocalDescriptors(this.hostObjectRegistry),
            classes: this.getLocalDescriptors(this.hostClassRegistry),
        }, replyChannel);
    }

    private getLocalDescriptors<T extends HostObjectRegistryEntry|ClassRegistryEntry>(registry: Map<string, T>): 
        T extends HostObjectRegistryEntry ? ObjectDescriptors : ClassDescriptors 
    {
        const descriptors: any = {};
        for (const key of registry.keys()) {
            // .get() could return undefined, but we know it will never do that, since we iterate over existing keys
            // therefore it is safe to cast it to the entry types
            const entry = <ClassRegistryEntry|HostObjectRegistryEntry>registry.get(key);

            const descr = descriptors[key] = { ...entry.descriptor };

            if (entry.descriptor.type === 'object' && entry.descriptor.readonlyProperties) {
                const props: any = {};
                for (const prop of entry.descriptor.readonlyProperties) {
                    props[prop] = (entry as HostObjectRegistryEntry).target[prop];
                }
                (descr as ObjectDescriptorWithProps).props = props;
            }
        }
        return descriptors;
    }

    private sendSync(message: RPC_Message, channel = this.channel) {
        this.addMarker(message);
        return channel?.sendSync?.(message);
    }

    private sendAsync(message: RPC_Message, channel = this.channel) {
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

    private checkMarker(message: RPC_Message) {
        return typeof message === 'object' && message.rpc_marker === 'srpc';
    }

    private callTargetFunction(msg: RPC_AnyCallMessage, replyChannel = this.channel) {
        const entry = this.hostObjectRegistry.get(msg.objId);
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
                    target[msg.prop] = this.processAfterSerialization(msg.args[0], replyChannel, descr?.get?.arguments?.[0]);
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

            if (msg.callType === 'async') {
                Promise.resolve(result)
                    .then(value => result = this.processBeforeSerialization(value, replyChannel), err => { result = err?.toString?.(); success = false; })
                    .then(() => this.sendAsync({ action: 'fn_reply', callType: 'async', success, result, callId: msg.callId }, replyChannel));
            } else {
                result = this.processBeforeSerialization(result, replyChannel);
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

    private messageReceived(message: RPC_Message, replyChannel = this.channel) {
        if (this.checkMarker(message)) {
            switch (message.action) {
                case 'get_descriptors': {
                    this.sendRemoteDescriptors(replyChannel);
                    break;
                }
                case 'descriptors': {
                    const success = this.setRemoteDescriptors(message);
                    this.remoteDescriptorsCallbacks?.[success ? 'resolve' : 'reject']();
                    this.remoteDescriptorsCallbacks = undefined;
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
                    this.hostObjectRegistry.delete(message.objId);
                    break;
                }
                case 'fn_reply': {
                    if (message.callType === 'async') {
                        const result = this.processAfterSerialization(message.result, replyChannel);
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
        return args.map((arg, idx) => this.processBeforeSerialization(arg, replyChannel, getArgumentDescriptor(func, idx)));
    }

    private deserializeFunctionArgs(func: FunctionDescriptor, args: any[], replyChannel: RPCChannel) {
        return args.map((arg, idx) => this.processAfterSerialization(arg, replyChannel, getArgumentDescriptor(func, idx)));
    }

    private createVoidProxyFunction(objId: string|null, func: FunctionDescriptor, action: RPC_VoidCallAction, replyChannel: RPCChannel) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const _this = this;
        const fn = function (this: any, ...args: any[]) {
            if ((fn as any)['rpc_disposed']) throw new Error('Remote function has been disposed');
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
            if ((fn as any)['rpc_disposed']) throw new Error('Remote function has been disposed');
            const response = _this.sendSync({ action, callType: 'sync', 
                objId: objId ?? this._rpc_objId,
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                prop: func.name!, 
                args: _this.serializeFunctionArgs(func, args, replyChannel) 
            }, replyChannel);

            if (!response) throw new Error('No response received');
            if (!_this.checkMarker(response)) throw new Error(`Invalid response ${JSON.stringify(response)}`);

            if (!response.success) throw new Error(response.result);
            return _this.processAfterSerialization(response.result, replyChannel);
        };
        return fn;
    }

    private createAsyncProxyFunction(objId: string|null, func: FunctionDescriptor, action: RPC_AsyncCallAction, replyChannel: RPCChannel) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const _this = this;
        const fn = function (this: any, ...args: any[]) {
            return new Promise((resolve, reject) => {
                if ((fn as any)['rpc_disposed']) throw new Error('Remote function has been disposed');
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

    private createProxyFunction(
        objId: string|null, 
        prop: string | FunctionDescriptor, 
        action: RPC_AnyCallAction, 
        defaultCallType: FunctionReturnBehavior = 'async', 
        replyChannel = this.channel) 
    {
        const descriptor = (typeof prop === 'object') ? prop : { name: prop };

        switch (descriptor?.returns || defaultCallType) {
            case 'void': return this.createVoidProxyFunction(objId, descriptor, <RPC_VoidCallAction>action, replyChannel);
            case 'sync': return this.createSyncProxyFunction(objId, descriptor, <RPC_SyncCallAction>action, replyChannel);
            default: return this.createAsyncProxyFunction(objId, descriptor, <RPC_AsyncCallAction>action, replyChannel);
        }
    }

    /**
     * Gets or creates a proxy object that represents a host object from the other side.
     * 
     * This side must have the descriptor for the object.
     * See [[sendRemoteDescriptors]], [[requestRemoteDescriptors]].
     */
    getProxyObject(objId: string) {
        let obj: any = this.proxyObjectRegistry.get(objId);
        if (obj) return obj;

        const descriptor = this.remoteObjectDescriptors?.[objId];
        if (!descriptor) {
            throw new Error(`No object registered with ID '${objId}'`);
        }

        if (isFunctionDescriptor(descriptor)) {
            obj = this.createProxyFunction(objId, descriptor, 'fn_call');
        } else {
            obj = this.createProxyObject(objId, descriptor);
        }

        this.proxyObjectRegistry.register(objId, obj);
        return obj;
    }

    /**
     * Gets or creates a proxy "class" that will serve multiple purposes.
     * - Static functions/properties on the class are proxied the same way as on a regular "host" object
     * - If specified the constructor actually constructs an instance of the registered host class on the other side 
     * and the returned instance will represent the remote instance, with the specified functions/properties working
     * on its prototype as expected.
     * - If an instance of the registered host class is being sent from the other side, 
     * an instance of this proxy class will be created and passed on this side.
     */
    getProxyClass(classId: string) {
        let clazz = this.proxyClassRegistry.get(classId);
        if (clazz) return clazz;

        const descriptor = this.remoteClassDescriptors?.[classId];
        if (!descriptor) {
            throw new Error(`No class registered with ID '${classId}'`);
        }

        clazz = descriptor.ctor ? this.createProxyFunction(classId + '.ctor', descriptor.ctor, 'ctor_call', 'sync') 
            : function () { throw new Error(`Constructor of class '${classId}' is not defined`); };

        // create the proxy functions/properties on the prototype with no objId, so each function will look up "_rpc_objId" on "this"
        // so the prototype will work with multiple instances
        this.createProxyObject(null, descriptor.instance as ObjectDescriptorWithProps, clazz.prototype);

        // add static functions/props
        const staticDescr = descriptor.static as ObjectDescriptorWithProps;
        const objDescr = this.remoteObjectDescriptors?.[classId];
        if (!isFunctionDescriptor(objDescr)) {
            staticDescr.props = objDescr?.props;
        }
        this.createProxyObject(classId, staticDescr, clazz);

        this.proxyClassRegistry.set(classId, clazz);

        return clazz;
    }

    private createProxyObject(objId: string|null, descriptor: ObjectDescriptorWithProps, obj: any = {}) {
        if (descriptor.props) Object.assign(obj, descriptor.props);

        if (descriptor.functions) for (const prop of descriptor.functions) {
            obj[getPropName(prop)] = this.createProxyFunction(objId, prop, 'method_call');
        }

        if (descriptor.proxiedProperties) for (const prop of descriptor.proxiedProperties) {
            const descr = typeof prop === 'string' ? { name: prop } : prop;
            Object.defineProperty(obj, descr.name, {
                get: this.createProxyFunction(objId, { ...descr.get, name: descr.name }, 'prop_get', 'sync'),
                set: descr.readonly ? undefined : this.createProxyFunction(objId, { ...descr.set, name: descr.name }, 'prop_set', 'sync')
            });
        }

        return obj;
    }

    private registerLocalObj(obj: any, descriptor: FunctionDescriptor | ObjectDescriptor) {
        let objId = obj._rpc_objId;
        if (!this.hostObjectRegistry.has(objId)) {
            objId = this.objectIdGenerator();
            this.hostObjectRegistry.set(objId, { target: obj, descriptor });
            obj._rpc_objId = objId;
        }
        return objId;
    }

    private processBeforeSerialization(obj: any, replyChannel: RPCChannel, descriptor?: Descriptor) {
        switch (typeof obj) {
            case 'object': {
                if (!obj) break;
                // special case for Promise
                if (obj.constructor === Promise) {
                    if (!this.hostObjectRegistry.has((obj as any)['_rpc_objId'])) {
                        let result: unknown;
                        let success: boolean;
                        obj.then(
                            (value) => { result = value; success = true; },
                            (value) => { result = value; success = false; }
                        ).finally(() => this.sendAsyncIfPossible({ action: 'fn_reply', callType: 'async', success, result, callId: objId }, replyChannel));
                    }
                    const objId = this.registerLocalObj(obj, {});
                    return { _rpc_type: 'object', props: { _rpc_objId: objId }, classId: 'Promise' };
                }

                const entry = this.hostClassRegistry.get(obj.constructor._rpc_classId);
                if (entry) {
                    const objId = this.registerLocalObj(obj, entry.descriptor.instance ?? {});
                    const props: any = { _rpc_objId: objId };

                    for (const prop of entry.descriptor.instance?.readonlyProperties ?? []) {
                        const propName = getPropName(prop);
                        props[propName] = this.processBeforeSerialization(obj[propName], replyChannel);
                    }

                    return { _rpc_type: 'object', classId: entry.descriptor.classId, props };
                }

                for (const key of Object.keys(obj)) {
                    obj[key] = this.processBeforeSerialization(obj[key], replyChannel);
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

    private processAfterSerialization(obj: any, replyChannel: RPCChannel, descriptor?: Descriptor) {
        if (typeof obj !== 'object' || !obj) return obj;

        switch (obj._rpc_type) {
            case 'object': {
                return this.getOrCreateProxyInstance(obj.classId, obj.props, replyChannel);
            }
            case 'function': {
                return this.getOrCreateProxyFunction(obj.objId, replyChannel, descriptor as FunctionDescriptor);
            }
        }

        for (const key of Object.keys(obj)) {
            obj[key] = this.processAfterSerialization(obj[key], replyChannel, getPropertyDescriptor(descriptor as ObjectDescriptor, key));
        }

        return obj;
    }

    private sendObjectDied(objId: string, replyChannel = this.channel) {
        this.sendAsyncIfPossible({ action: 'obj_died', objId }, replyChannel);
    }

    private getOrCreateProxyInstance(classId: string, props: any, replyChannel: RPCChannel) {
        const objId = props._rpc_objId;
        let obj = this.proxyObjectRegistry.get(objId);
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

        this.proxyObjectRegistry.register(objId, obj, () => this.sendObjectDied(objId, replyChannel));
        return obj;
    }

    private getOrCreateProxyFunction(objId: string, replyChannel: RPCChannel, descriptor?: FunctionDescriptor) {
        let fn = this.proxyObjectRegistry.get(objId);
        if (!fn) {
            if (descriptor) descriptor.type = 'function';
            fn = this.createProxyFunction(objId, <any>descriptor, 'fn_call', 'async', replyChannel);
            this.proxyObjectRegistry.register(objId, fn, () => this.sendObjectDied(objId, replyChannel));
        }
        return fn;
    }

}
