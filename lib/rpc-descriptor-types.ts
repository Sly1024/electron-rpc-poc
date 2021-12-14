export type FunctionReturnType = 'sync' | 'async' | 'void';
export type PropertyReturnType = Exclude<FunctionReturnType, 'void'>;

export type PropertyDescriptor = {
    type?: 'property';
    name: string;
    get?: FunctionDescriptor<PropertyReturnType>;   // default is 'sync'
    set?: FunctionDescriptor<'void' | 'sync'>;
    readonly?: boolean;   // default is false
}

export type FunctionDescriptor<TReturn extends FunctionReturnType = FunctionReturnType> = {
    type?: 'function';
    name?: string;
    arguments?: ArgumentDescriptor[];
    returns?: TReturn;   // default is 'async'
};

export type ArgumentDescriptor = FunctionDescriptor & {
    idx?: number;   // default: all
};

export type ObjectDescriptor = {
    type?: 'object';
    classId?: string;
    functions?: (string|FunctionDescriptor)[];
    proxiedProperties?: (string|PropertyDescriptor)[];
};

export type ClassDescriptor = ObjectDescriptor & {
    ctor?: FunctionDescriptor;
    staticFunctions?: (string|FunctionDescriptor)[];
    staticProperties?: (string|PropertyDescriptor)[];
    readonlyProperties?: string[];
};

export type Descriptor = ObjectDescriptor | FunctionDescriptor | PropertyDescriptor;

export type ObjectDescriptors = { [key: string]: ObjectDescriptor | FunctionDescriptor };
export type ClassDescriptors = { [key: string]: ClassDescriptor };

// util functions
export function getPropName(descriptor: string | { name?: string }) {
    return typeof descriptor === 'string' ? descriptor : descriptor.name;
}

export function getArgumentDescriptor(descriptor: FunctionDescriptor, idx?: number) {
    return typeof descriptor === 'object' && descriptor.arguments?.find(arg => arg.idx == null || arg.idx === idx);
}

export function getFunctionDescriptor(descriptor: ObjectDescriptor, funcName: string) {
    return <FunctionDescriptor>descriptor.functions?.find(func => typeof func === 'object' && func.name === funcName);
}

export function getPropertyDescriptor(descriptor?: ObjectDescriptor, propName?: string) {
    return <PropertyDescriptor>descriptor?.proxiedProperties?.find(prop => typeof prop === 'object' && prop.name === propName);
}