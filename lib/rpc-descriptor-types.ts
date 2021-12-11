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

export type ArgumentDescriptor = (FunctionDescriptor|PropertyDescriptor) & {
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
