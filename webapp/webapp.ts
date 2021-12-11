import {RPCChannel, RPCService} from '../lib/rpc-proxy';

declare const rpcChannel: RPCChannel;

const rpc = new RPCService();
rpc.connect(rpcChannel);

rpc.requestRemoteDescriptors();

export const api = rpc.createProxyObject('servobj');
export const Tiger = rpc.createProxyClass('Tiger');

export const BrowserWindow = rpc.createProxyClass('BrowserWindow');
