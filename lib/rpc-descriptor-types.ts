export type ReturnType = 'sync' | 'async' | 'void';

export type PropertyDescriptor = {
    name: string;
    returns?: 'sync' | 'async';   // default is 'sync'
    readonly: boolean;              // default false
}

export type FunctionDescriptor = {
    type?: 'function';
    name?: string;
    arguments?: ArgumentDescriptor[];
    returns?: ReturnType;   // default is 'sync'
};

export type ArgumentDescriptor = FunctionDescriptor & {
    idx?: number;   // default: all
};

export type ObjectDescriptor = {
    type?: 'object';
    functions?: (string|FunctionDescriptor)[];
    proxiedProperties?: (string|PropertyDescriptor)[];
};

export type ObjectDescriptors = { [key: string] : ObjectDescriptor|FunctionDescriptor };

export type ClassDescriptor = ObjectDescriptor & {
    staticFunctions?: (string|FunctionDescriptor)[];
    readonlyProperties?: (string|PropertyDescriptor)[];
};
