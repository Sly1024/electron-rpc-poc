import { nanoid } from 'nanoid/non-secure';
import { RPCChannel, RPCService } from '../lib/rpc-proxy';

declare const rpcChannel: RPCChannel;

const rpc = new RPCService(nanoid);
rpc.connect(rpcChannel);

rpc.requestRemoteDescriptors();

export const api = rpc.getProxyObject('servobj');
export const Tiger = rpc.getProxyClass('Tiger');

export const BrowserWindow = rpc.getProxyClass('BrowserWindow');
