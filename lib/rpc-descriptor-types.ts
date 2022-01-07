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
export type FunctionReturnBehavior = 'sync' | 'async' | 'void';

/**
 * Describes a function, its arguments and its return type.
 */
export interface FunctionDescriptor<TReturn extends FunctionReturnBehavior = FunctionReturnBehavior> {
    type?: 'function';
    name?: string;

    /**
     * Describes the arguments of the function.
     *
     * Currently only functions need to be described with a [[FunctionDescriptor]], otherwise no descriptor is needed.
     */
    arguments?: ArgumentDescriptor[];

    /**
     * Return behavior.
     */
    returns?: TReturn;
}

/**
 * Describes a property.
 */
export interface PropertyDescriptor {
    type?: 'property';
    name: string;

    /**
     * The getter of the property.
     * If set to 'async' then it returns a Promise.
     * Default return behavior is 'sync'.
     */
    get?: FunctionDescriptor<'sync' | 'async'>;

    /**
     * The setter of the property.
     * Default return behavior is 'sync'.
     */
    set?: FunctionDescriptor<'void' | 'sync'>;

    /**
     * If `true` then no setter will be generated for the proxy property.
     * @default false
     */
    readonly?: boolean;
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
     * Default return behavior is 'async'.
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
export interface ClassDescriptor {
    type?: 'class';

    /**
     * Ignore this. Filled in by [[registerHostClass]] function.
     */
    classId?: string;

    /**
     * Expose a constructor function that will construct an instance on the host side.
     * Default return behavior is 'sync'.
     */
    ctor?: FunctionDescriptor;

    /**
     * Describes the "static" part of the class, treated as an object.
     */
    static?: ObjectDescriptor;

    /**
     * Describes instances of this class.
     */
    instance?: ObjectDescriptor;
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

export function isFunctionDescriptor(descriptor?: Descriptor): descriptor is FunctionDescriptor {
    return descriptor?.type === 'function';
}