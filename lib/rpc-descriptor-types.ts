/**
 * The descriptors are used to describe what properties/functions to expose on an object 
 * and what are the function return behaviors.
 * @module
 */

/**
 * Function return behaviors are the following:
 * - sync  - the proxy function will return the result synchronously (works only if the channel supports synchronous communication)
 * - async - the proxy function will return a Promise (works only if the channel supports asynchronous communication)
 * - void  - the return value is ignored and no result message is sent
 * 
 * @see [[RPCChannel]]
 */
export type FunctionReturnType = 'sync' | 'async' | 'void';

/**
 * Describes a function, its arguments and its return type.
 */
export interface FunctionDescriptor<TReturn extends FunctionReturnType = FunctionReturnType> {
    type?: 'function';
    name?: string;
    arguments?: ArgumentDescriptor[];
    returns?: TReturn;   // default is 'async'
}

/**
 * Describes a property.
 */
export interface PropertyDescriptor {
    type?: 'property';
    name: string;

    /**
     * The getter of the property. Default return behavior is 'sync'. 
     * If set to 'async' then it returns a Promise.
     */
    get?: FunctionDescriptor<'sync' | 'async'>;   // default is 'sync'

    /**
     * The setter of the property. Default return behavior is 'void'.
     */
    set?: FunctionDescriptor<'void' | 'sync'>;

    /**
     * If `true` then no setter will be generated for the proxy property.
     */
    readonly?: boolean;   // default is false
}    

/**
 * Describes an argument for a function. If `idx` is not set then this
 * descriptor applies to *all* arguments.
 * 
 * Since we only care about functions as arguments, for now, it is basically a FunctionDescriptor.
 * If the argument is not a function, do not specify a descriptor for it!
 */
export interface ArgumentDescriptor extends FunctionDescriptor {
    idx?: number;
}

/**
 * Describes an object that we want to expose.
 */
export interface ObjectDescriptor {
    type?: 'object';

    /**
     * List of functions we want to expose on the proxy object.
     */
    functions?: (string|FunctionDescriptor)[];

    /**
     * List of properties we want to expose on the proxy object.
     */
    proxiedProperties?: (string|PropertyDescriptor)[];

    /**
     * Since readonly property values don't change, they are sent to the other side, instead of generating a getter.
     */
    readonlyProperties?: string[];
}

export interface ObjectDescriptorWithProps extends ObjectDescriptor {
    /**
     * This is filled in by the library. It contains the values of the readonlyProperties on the given object.
     */
    props?: any;
}

/**
 * Describes a class to expose. 
 */
export interface ClassDescriptor extends ObjectDescriptor {
    /**
     * Ignore this. Filled in by [[registerHostClass]] function.
     */
    classId?: string;

    /**
     * Expose a constructor function that will construct an instance on the host side.
     */
    ctor?: FunctionDescriptor;

    /**
     * Same as "functions" on an object.
     */
    staticFunctions?: (string|FunctionDescriptor)[];

    /**
     * Same as "proxiedProperties" on an object.
     */
    staticProxiedProperties?: (string|PropertyDescriptor)[];

    /**
     * Same as "readonlyProperties" on an object.
     */
    staticReadonlyProperties?: string[];
}

export type Descriptor = ObjectDescriptor | FunctionDescriptor | PropertyDescriptor;

export type ObjectDescriptors = { [key: string]: ObjectDescriptorWithProps | FunctionDescriptor };
export type ClassDescriptors = { [key: string]: ClassDescriptor };

// util functions
export function getPropName(descriptor: string | { name?: string }) {
    return typeof descriptor === 'string' ? descriptor : descriptor.name || '';
}

export function getArgumentDescriptor(descriptor: FunctionDescriptor, idx?: number) {
    return typeof descriptor === 'object' ? descriptor.arguments?.find(arg => arg.idx == null || arg.idx === idx) : undefined;
}

export function getFunctionDescriptor(descriptor: ObjectDescriptor, funcName: string) {
    return <FunctionDescriptor>descriptor?.functions?.find(func => typeof func === 'object' && func.name === funcName);
}

export function getPropertyDescriptor(descriptor?: ObjectDescriptor, propName?: string) {
    return <PropertyDescriptor>descriptor?.proxiedProperties?.find(prop => typeof prop === 'object' && prop.name === propName);
}