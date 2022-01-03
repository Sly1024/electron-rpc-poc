import { RPCChannel, RPCService } from './rpc-proxy';
import { RPC_Message } from './rpc-message-types';
import { nanoid } from 'nanoid/non-secure';

const realTimeout = setTimeout;

let channel1: RPCChannel, channel2: RPCChannel;
let rpc1: RPCService, rpc2: RPCService;

let timeoutIds: NodeJS.Timeout[];

const delayPromise = (milli: number, doReject = false) => new Promise((resolve, reject) => {
    const timeoutId = realTimeout(() => {
        const idx = timeoutIds.indexOf(timeoutId);
        timeoutIds.splice(idx, 1);
        doReject ? reject() : resolve(undefined);
    }, milli);

    timeoutIds.push(timeoutId);
});

const waitForAllTimers = () => Promise.race([
    delayPromise(4000, true),
    (async () => {
        await delayPromise(0);
        while (jest.getTimerCount() > 0) {
            await delayPromise(0);
            jest.runOnlyPendingTimers();
        }
    })()
]);

beforeEach(() => {
    timeoutIds = [];
});

afterEach(() => {
    jest.useRealTimers();
    timeoutIds.forEach(id => clearTimeout(id));
});

beforeEach(() => {
    // set up the two endpoints of the channel
    channel1 = {};
    channel2 = {};

    let channel1Receive: (message: RPC_Message, replyChannel?: RPCChannel) => void;
    let channel2Receive: (message: RPC_Message, replyChannel?: RPCChannel) => void;

    channel1.receive = ((callback) => channel1Receive = callback);
    channel2.receive = ((callback) => channel2Receive = callback);

    let channel1SyncReplyMessage: any;
    let channel2SyncReplyMessage: any;

    const channel1ReplyChannel = { 
        sendSync: (msg: RPC_Message) => channel1SyncReplyMessage = msg,
        sendAsync: (message: RPC_Message) => Promise.resolve().then(() => channel1Receive(message, channel2ReplyChannel))
    };

    const channel2ReplyChannel = { 
        sendSync: (msg: RPC_Message) => channel2SyncReplyMessage = msg,
        sendAsync: (message: RPC_Message) => Promise.resolve().then(() => channel2Receive(message, channel1ReplyChannel))
    };

    channel1.sendSync = (message) => (channel2Receive(message, channel1ReplyChannel), channel1SyncReplyMessage);
    channel2.sendSync = (message) => (channel1Receive(message, channel2ReplyChannel), channel2SyncReplyMessage);

    channel1.sendAsync = channel2ReplyChannel.sendAsync;
    channel2.sendAsync = channel1ReplyChannel.sendAsync;

    // create the two service instances
    rpc1 = new RPCService(nanoid);
    rpc2 = new RPCService(nanoid);

    rpc1.connect(channel1);
    rpc2.connect(channel2);
});

describe('mock channel', () => {
    test('sendSync works', () => {
        const testMsg: any = {};
        const testReply: any = {};

        channel1.receive?.((message, replyChannel) => {
            expect(message).toBe(testMsg);
            replyChannel?.sendSync?.(testReply);
        });
        const reply = channel2.sendSync?.(testMsg);

        expect(reply).toBe(testReply);
    });

    test('sendAsync works', (done) => {
        const testMsg: any = {};
        const testReply: any = {};

        channel2.receive?.((message) => {
            expect(message).toBe(testReply);
            done();
        });

        channel1.receive?.((message, replyChannel) => {
            expect(message).toBe(testMsg);
            replyChannel?.sendAsync?.(testReply);
        });

        channel2.sendAsync?.(testMsg);
    });
});

describe('host object', () => {
    let hostObj: any;
    let proxyObj: any;

    beforeEach(() => {
        hostObj = {
            syncFunc(a: number, b: number) { return a + b; },
            failSyncFunc() { throw new Error('ErRoR'); },
            asyncFunc(ping: string) {
                return new Promise((resolve) => {
                    setTimeout(() => {
                        resolve(ping + 'pong');
                    }, 100);
                });
            },
            failAsyncFunc(ping: string) {
                return new Promise((_resolve, reject) => {
                    setTimeout(() => {
                        reject(ping + 'pong');
                    }, 100);
                });
            },
        };

        rpc1.registerHostObject('host_obj', hostObj, {
            functions: [
                { name: 'syncFunc', returns: 'sync'},
                { name: 'failSyncFunc', returns: 'sync'},
                { name: 'asyncFunc', returns: 'async'},
                { name: 'failAsyncFunc', returns: 'async'},
            ]
        });

        rpc1.sendRemoteDescriptors();

        proxyObj = rpc2.getProxyObject('host_obj');
    });

    test('sync function success', () => {
        expect(proxyObj.syncFunc(2, 3)).toBe(5);
    });

    test('sync function failure', () => {
        expect(() => proxyObj.failSyncFunc()).toThrowError('ErRoR');
    });

    test('async function success', async () => {
        jest.useFakeTimers();
        const promise = proxyObj.asyncFunc('ping');
        await waitForAllTimers();
        await expect(promise).resolves.toEqual('pingpong');
    });

    test('async function failure', async () => {
        jest.useFakeTimers();
        const promise = proxyObj.failAsyncFunc('ping');
        await waitForAllTimers();
        await expect(promise).rejects.toEqual('pingpong');
    });

});