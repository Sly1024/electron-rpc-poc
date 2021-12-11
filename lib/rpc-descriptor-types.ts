export type FunctionReturnType = 'sync' | 'async' | 'void';
export type PropertyReturnType = Exclude<FunctionReturnType, 'void'>;

export type PropertyDescriptor = {
    name: string;
    argument?: ArgumentDescriptor;
    returns?: PropertyReturnType;   // default is 'sync'
    readonly?: boolean;             // default false
}

export type FunctionDescriptor = {
    type?: 'function';
    name?: string;
    arguments?: ArgumentDescriptor[];
    returns?: FunctionReturnType;   // default is 'async'
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
    staticFunctions?: (string|FunctionDescriptor)[];
    staticProperties?: (string|PropertyDescriptor)[];
    readonlyProperties?: (string|PropertyDescriptor)[];
};

export type Descriptor = ObjectDescriptor | FunctionDescriptor;

export type ObjectDescriptors = { [key: string]: Descriptor };
export type ClassDescriptors = { [key: string]: ClassDescriptor };

// util functions
export function getPropName(descriptor: string | { name?: string }) {
    return typeof descriptor === 'string' ? descriptor : descriptor.name;
}

export function getArgumentDescriptorByIdx(func: FunctionDescriptor, idx?: number) {
    return typeof func === 'object' ? func.arguments?.find(arg => arg.idx == null || arg.idx === idx) : undefined;
}

export function getFunctionDescriptor(descriptor: ObjectDescriptor, funcName: string) {
    return <FunctionDescriptor>descriptor.functions?.find(func => typeof func === 'object' && func.name === funcName);
}

export function getPropertyDescriptor(descriptor: ObjectDescriptor, propName: string) {
    return <PropertyDescriptor>descriptor.proxiedProperties?.find(prop => typeof prop === 'object' && prop.name === propName);
}