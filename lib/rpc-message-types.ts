import type { ClassDescriptors, ObjectDescriptors } from './rpc-descriptor-types';

export type RPC_Marker = { rpc_marker?: 'webrpc' };

// descriptor request & response
export type RPC_GetDescriptorsMessage = RPC_Marker & { action: 'get_descriptors' };
export type RPC_DescriptorsResultMessage = RPC_Marker & { action: 'descriptors', objects: ObjectDescriptors, classes: ClassDescriptors };

// function call messages
export type RPC_FnCallMessageBase = RPC_Marker & { objId: string, args: any[] };
export type RPC_VoidFnCallMessage = RPC_FnCallMessageBase & { callType: 'void' };
export type RPC_SyncFnCallMessage = RPC_FnCallMessageBase & { callType: 'sync' };
export type RPC_AsyncFnCallMessage = RPC_FnCallMessageBase & { callType: 'async', callId: number | string };
export type RPC_AllFnCallMessage = RPC_VoidFnCallMessage | RPC_SyncFnCallMessage | RPC_AsyncFnCallMessage;

export type RPC_FnCallMessage = { action: 'fn_call' } & RPC_AllFnCallMessage;
export type RPC_CtorCallMessage = { action: 'ctor_call' } & (RPC_SyncFnCallMessage | RPC_AsyncFnCallMessage);
export type RPC_PropGetMessage = { action: 'prop_get', prop: string } & (RPC_SyncFnCallMessage | RPC_AsyncFnCallMessage);
export type RPC_PropSetMessage = { action: 'prop_set', prop: string } & RPC_VoidFnCallMessage;
export type RPC_RpcCallMessage = { action: 'method_call', prop: string } & RPC_AllFnCallMessage;

export type RPC_AnyCallMessage = RPC_FnCallMessage | RPC_CtorCallMessage | RPC_PropGetMessage | RPC_PropSetMessage | RPC_RpcCallMessage;

export type RPC_CallAction = RPC_AnyCallMessage['action'];
export type RPC_VoidCallAction = (RPC_AnyCallMessage & { callType: 'void'})['action'];
export type RPC_SyncCallAction = (RPC_AnyCallMessage & { callType: 'sync'})['action'];
export type RPC_AsyncCallAction = (RPC_AnyCallMessage & { callType: 'async'})['action'];

// function result messages
export type RPC_FnResultMessageBase = RPC_Marker & { action: 'fn_reply', success: boolean; result: any };
export type RPC_SyncFnResultMessage = RPC_FnResultMessageBase & { callType: 'sync'};
export type RPC_AsyncFnResultMessage = RPC_FnResultMessageBase & { callType: 'async', callId: number | string };
export type RPC_FnResultMessage = RPC_SyncFnResultMessage | RPC_AsyncFnResultMessage;

export type RPC_ObjectDiedMessage = RPC_Marker & { action: 'obj_died', objId: string };
export type RPC_AsyncCallbackCallMessage = RPC_Marker & { action: 'async_fn', objId: string, args: any[] };

export type RPC_Message = RPC_GetDescriptorsMessage | RPC_DescriptorsResultMessage |
    RPC_AnyCallMessage | RPC_FnResultMessage | RPC_AsyncCallbackCallMessage | RPC_ObjectDiedMessage;
    