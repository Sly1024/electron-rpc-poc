import { ClassDescriptors, ObjectDescriptors } from './rpc-descriptor-types';

export type RPC_MessageBase = { rpc_marker?: 'webrpc', error?: any };

// descriptor request & response
export type RPC_GetDescriptorsMessage = RPC_MessageBase & { action: 'get_descriptors' };
export type RPC_DescriptorsResultMessage = RPC_MessageBase & { action: 'descriptors', objects: ObjectDescriptors, classes: ClassDescriptors };

// function call messages
export type RPC_FnCallMessageBase = RPC_MessageBase & { objId: string, args: any[] };
export type RPC_VoidFnCallMessage = RPC_FnCallMessageBase & { callType: 'void' };
export type RPC_SyncFnCallMessage = RPC_FnCallMessageBase & { callType: 'sync' };
export type RPC_AsyncFnCallMessage = RPC_FnCallMessageBase & { callType: 'async', callId: number };
export type RPC_AllFnCallMessage = RPC_VoidFnCallMessage | RPC_SyncFnCallMessage | RPC_AsyncFnCallMessage;

export type RPC_FnCallMessage = { action: 'fn_call' } & RPC_AllFnCallMessage;
export type RPC_PropGetMessage = { action: 'prop_get', prop: string } & RPC_AllFnCallMessage;
export type RPC_PropSetMessage = { action: 'prop_set', prop: string } & RPC_AllFnCallMessage;
export type RPC_RpcCallMessage = { action: 'rpc_call', prop: string } & RPC_AllFnCallMessage;

export type RPC_CallAction = (RPC_FnCallMessage | RPC_RpcCallMessage | RPC_PropGetMessage | RPC_PropSetMessage)['action'];

// function result messages
export type RPC_FnResultMessageBase = RPC_MessageBase & { action: 'fn_reply', success: boolean; result: any };
export type RPC_SyncFnResultMessage = RPC_FnResultMessageBase & { callType: 'sync'};
export type RPC_AsyncFnResultMessage = RPC_FnResultMessageBase & { callType: 'async', callId: number };
export type RPC_FnResultMessage = RPC_SyncFnResultMessage | RPC_AsyncFnResultMessage;

export type RPC_ObjectDiedMessage = RPC_MessageBase & { action: 'obj_died', objId: string };
export type RPC_AsyncCallbackCallMessage = RPC_MessageBase & { action: 'async_fn', objId: string, args: any[] };

export type RPC_Message = RPC_GetDescriptorsMessage | RPC_DescriptorsResultMessage |
    RPC_FnCallMessage | RPC_PropGetMessage | RPC_PropSetMessage| RPC_RpcCallMessage | 
    RPC_FnResultMessage | RPC_AsyncCallbackCallMessage | RPC_ObjectDiedMessage;
    