import { AnyConstructor, RPCChannel, RPCService } from '../rpc-proxy';
import { RPC_Message } from '../rpc-message-types';
import { nanoid } from 'nanoid/non-secure';
import { waitForAllTimers, delayPromise } from './utils';
import { rpc_disposeFunc } from '../proxy-object-registry';

describe('RPCService', () => {
    let channel1: RPCChannel;
    let channel2: RPCChannel;
    let channel1ReplyChannel: RPCChannel;
    let channel2ReplyChannel: RPCChannel;
    let rpc1: RPCService;
    let rpc2: RPCService;

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

        channel1ReplyChannel = {
            sendSync: (msg: RPC_Message) => channel1SyncReplyMessage = msg,
            sendAsync: (message: RPC_Message) => Promise.resolve().then(() => channel1Receive(message, channel2ReplyChannel))
        };

        channel2ReplyChannel = {
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

        test('sendAsync works', (done: () => void) => {
            const testMsg: any = {};
            const testReply: any = {};

            // the actual execution order is backwards:
            // - channel2 send(testMsg)
            // - channel1 receive(testMsg) + send(testReply)
            // - channel2 receive(testReply)

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
                        setTimeout(() => { resolve(ping + 'pong'); }, 100);
                    });
                },
                failAsyncFunc(ping: string) {
                    return new Promise((_resolve, reject) => {
                        setTimeout(() => { reject(ping + 'err'); }, 100);
                    });
                },
                roID: 'readonly',
                counter: 1,

                // event emitter emulation
                listeners: [],
                addListener(listener: (data: any) => void) {
                    this.listeners.push(listener);
                },
                removeListener(listener: (data: any) => void) {
                    this.listeners.splice(this.listeners.indexOf(listener), 1);
                },
                fireListeners(data: any) {
                    this.listeners.forEach((listener: (data: any) => void) => listener(data));
                }
            };

            rpc1.registerHostObject('host_obj', hostObj, {
                functions: [
                    { name: 'syncFunc', returns: 'sync'},
                    { name: 'failSyncFunc', returns: 'sync'},
                    { name: 'asyncFunc', returns: 'async'},
                    { name: 'failAsyncFunc', returns: 'async'},
                    'addListener', 'removeListener', 'fireListeners'
                ],
                readonlyProperties: ['roID'],
                proxiedProperties: ['counter']
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
            await expect(promise).rejects.toEqual('pingerr');
        });

        test('readonly prop', () => {
            expect(proxyObj.roID).toBe('readonly');
        });

        test('proxied prop', () => {
            expect(hostObj.counter).toBe(1);
            expect(proxyObj.counter).toBe(1);
            proxyObj.counter++;
            expect(hostObj.counter).toBe(2);
            expect(proxyObj.counter).toBe(2);
        });

        test('passing a function (listener)', async () => {
            const listener = jest.fn();
            const data = {};
            const data2 = {};

            await proxyObj.addListener(listener);

            await proxyObj.fireListeners(data);
            expect(listener.mock.calls.length).toBe(1);
            expect(listener.mock.calls[0][0]).toBe(data);

            await proxyObj.fireListeners(data2);
            expect(listener.mock.calls.length).toBe(2);
            expect(listener.mock.calls[1][0]).toBe(data2);

            await proxyObj.removeListener(listener);
            await proxyObj.fireListeners(data2);
            expect(listener.mock.calls.length).toBe(2);
        });
    });

    describe('host function', () => {
        test('sync', () => {
            // setup
            const hostFunc = jest.fn(x => x * 2);
            rpc1.registerHostFunction('host_func', hostFunc, { returns: 'sync' });
            rpc1.sendRemoteDescriptors();
            const proxyFunc = rpc2.getProxyObject('host_func');

            const result = proxyFunc(7);

            expect(result).toBe(14);
            expect(hostFunc.mock.calls.length).toBe(1);
        });

        test('sync fail', () => {
            // setup
            const hostFunc = jest.fn(() => { throw new Error('error1'); });
            rpc1.registerHostFunction('host_func', hostFunc, { returns: 'sync' });
            rpc1.sendRemoteDescriptors();
            const proxyFunc = rpc2.getProxyObject('host_func');

            expect(() => proxyFunc(7)).toThrowError();
        });

        test('async', async () => {
            // setup
            const hostFunc = jest.fn(x => Promise.resolve(x * 2));
            rpc1.registerHostFunction('host_func', hostFunc, { returns: 'async' });
            rpc1.sendRemoteDescriptors();
            const proxyFunc = rpc2.getProxyObject('host_func');

            const result = await proxyFunc(7);

            expect(result).toBe(14);
            expect(hostFunc.mock.calls.length).toBe(1);
        });

        test('async fail', async () => {
            // setup
            const hostFunc = jest.fn(() => Promise.reject('error'));
            rpc1.registerHostFunction('host_func', hostFunc, { returns: 'async' });
            rpc1.sendRemoteDescriptors();
            const proxyFunc = rpc2.getProxyObject('host_func');

            await expect(proxyFunc(7)).rejects.toMatch('error');
        });
    });

    describe('host Class', () => {
        let hostClass: any;
        let proxyClass: any;

        beforeEach(() => {
            hostClass = class {
                static readonly CONSTANT = 'foo';
                static counter = 0;
                constructor(public readonly name: string) {
                    hostClass.counter++;
                }

                static createInstance(name: string) {
                    return new hostClass(name);
                }

                color = 'blue';

                getDescription() {
                    return this.color + ' ' + this.name;
                }
            };

            rpc1.registerHostClass('test_class', hostClass, {
                ctor: {},
                static: {
                    readonlyProperties: ['CONSTANT'],
                    proxiedProperties: ['counter'],
                    functions: ['createInstance']
                },
                instance: {
                    readonlyProperties: ['name'],
                    proxiedProperties: ['color'],
                    functions: ['getDescription']
                }
            });

            rpc2.requestRemoteDescriptors();

            proxyClass = rpc2.getProxyClass('test_class');
        });

        test('ctor', () => {
            let proxyObj = new proxyClass('test');
            expect(proxyObj).toBeDefined();
            expect(hostClass.counter).toBe(1);
            expect(proxyClass.counter).toBe(1);

            proxyObj = new proxyClass('test_1');
            expect(hostClass.counter).toBe(2);
            expect(proxyClass.counter).toBe(2);
        });

        it('static readonly props', () => {
            expect(proxyClass.CONSTANT).toEqual('foo');
        });

        test('returning an instance + readonly property', async () => {
            const instance = await proxyClass.createInstance('test2');
            expect(instance).toBeDefined();
            expect(instance.name).toEqual('test2');
            expect(hostClass.counter).toBe(1);
        });

        test('proxied property + instance method', async () => {
            const instance = new proxyClass('test3');
            expect(instance).toBeDefined();

            expect(instance.color).toEqual('blue');

            instance.color = 'green';

            expect(instance.color).toEqual('green');
            expect(await instance.getDescription()).toEqual('green test3');
        });
    });

    // A copy of the "host Class" test suite, except with a sync-only channel
    describe('sync only', () => {
        let hostClass: any;
        let proxyClass: any;

        beforeEach(() => {
            delete channel1.sendAsync;
            delete channel2.sendAsync;
            delete channel1ReplyChannel.sendAsync;
            delete channel2ReplyChannel.sendAsync;
        });

        beforeEach(async () => {
            hostClass = class {
                static readonly CONSTANT = 'foo';
                static counter = 0;
                constructor(public readonly name: string) {
                    hostClass.counter++;
                }

                static createInstance(name: string) {
                    return new hostClass(name);
                }

                color = 'blue';

                getDescription() {
                    return this.color + ' ' + this.name;
                }
            };

            rpc1.registerHostClass('test_class', hostClass, {
                ctor: {},
                static: {
                    readonlyProperties: ['CONSTANT'],
                    proxiedProperties: ['counter'],
                    functions: [ { name: 'createInstance', returns: 'sync' }]
                },
                instance: {
                    readonlyProperties: ['name'],
                    proxiedProperties: ['color'],
                    functions: [{ name: 'getDescription', returns: 'sync' }]
                }
            });

            await rpc2.requestRemoteDescriptors();

            proxyClass = rpc2.getProxyClass('test_class');
        });

        test('ctor', () => {
            let proxyObj = new proxyClass('test');
            expect(proxyObj).toBeDefined();
            expect(hostClass.counter).toBe(1);
            expect(proxyClass.counter).toBe(1);

            proxyObj = new proxyClass('test_1');
            expect(hostClass.counter).toBe(2);
            expect(proxyClass.counter).toBe(2);
        });

        it('static readonly props', () => {
            expect(proxyClass.CONSTANT).toEqual('foo');
        });

        test('returning an instance + readonly property', async () => {
            const instance = await proxyClass.createInstance('test2');
            expect(instance).toBeDefined();
            expect(instance.name).toEqual('test2');
            expect(hostClass.counter).toBe(1);
        });

        test('proxied property + instance method', async () => {
            const instance = new proxyClass('test3');
            expect(instance).toBeDefined();

            expect(instance.color).toEqual('blue');

            instance.color = 'green';

            expect(instance.color).toEqual('green');
            expect(await instance.getDescription()).toEqual('green test3');
        });
    });

    // A copy of the "host Class" test suite, except with an async-only channel
    describe('async only', () => {
        let hostClass: any;
        let proxyClass: any;

        beforeEach(() => {
            delete channel1.sendSync;
            delete channel2.sendSync;
            delete channel1ReplyChannel.sendSync;
            delete channel2ReplyChannel.sendSync;
        });

        beforeEach(async () => {
            hostClass = class {
                static readonly CONSTANT = 'foo';
                static counter = 0;
                constructor(public readonly name: string) {
                    hostClass.counter++;
                }

                static createInstance(name: string) {
                    return new hostClass(name);
                }

                color = 'blue';

                getDescription() {
                    return this.color + ' ' + this.name;
                }
            };

            rpc1.registerHostClass('test_class', hostClass, {
                ctor: { returns: 'async' },
                static: {
                    readonlyProperties: ['CONSTANT'],
                    proxiedProperties: [{ name: 'counter', get: { returns: 'async' }, set: { returns: 'void'} }],
                    functions: ['createInstance']
                },
                instance: {
                    readonlyProperties: ['name'],
                    proxiedProperties: [{ name: 'color', get: { returns: 'async' }, set: { returns: 'void'} }],
                    functions: ['getDescription']
                }
            });

            await rpc2.requestRemoteDescriptors();

            proxyClass = rpc2.getProxyClass('test_class');
        });

        test('ctor', async () => {
            let proxyObj = await new proxyClass('test');
            expect(proxyObj).toBeDefined();
            expect(hostClass.counter).toBe(1);
            expect(await proxyClass.counter).toBe(1);

            proxyObj = await new proxyClass('test_1');
            expect(hostClass.counter).toBe(2);
            expect(await proxyClass.counter).toBe(2);
        });

        it('static readonly props', () => {
            expect(proxyClass.CONSTANT).toEqual('foo');
        });

        test('returning an instance + readonly property', async () => {
            const instance = await proxyClass.createInstance('test2');
            expect(instance).toBeDefined();
            expect(instance.name).toEqual('test2');
            expect(hostClass.counter).toBe(1);
        });

        test('proxied property + instance method', async () => {
            const instance = await new proxyClass('test3');
            expect(instance).toBeDefined();

            expect(await instance.color).toEqual('blue');

            instance.color = 'green';

            expect(await instance.color).toEqual('green');
            expect(await instance.getDescription()).toEqual('green test3');
        });
    });

    describe('errors', () => {
        test('no object registered with ID', () => {
            expect(() => rpc1.getProxyObject('fake')).toThrowError();
        });

        test('no class registered with ID', () => {
            expect(() => rpc1.getProxyClass('fake')).toThrowError();
        });

        test('no constructor exposed', () => {
            rpc1.registerHostClass('c1', class {}, {});
            rpc1.sendRemoteDescriptors();
            const clazz = <AnyConstructor>rpc2.getProxyClass('c1');

            expect(() => new clazz()).toThrowError();
        });

        test('function disposed', async () => {
            rpc1.registerHostFunction('f1', jest.fn(), { returns: 'void' });
            rpc1.registerHostFunction('f2', jest.fn(), { returns: 'sync' });
            rpc1.registerHostFunction('f3', jest.fn(), { returns: 'async' });
            rpc1.sendRemoteDescriptors();

            const proxyFunc1 = rpc2.getProxyObject('f1');
            proxyFunc1[rpc_disposeFunc]();
            expect(() => { proxyFunc1(); }).toThrowError();

            const proxyFunc2 = rpc2.getProxyObject('f2');
            proxyFunc2[rpc_disposeFunc]();
            expect(() => { proxyFunc2(); }).toThrowError();

            const proxyFunc3 = rpc2.getProxyObject('f3');
            proxyFunc3[rpc_disposeFunc]();
            await expect(() => proxyFunc3()).rejects.toThrowError();
        });

        test('async method throws', async () => {
            rpc1.registerHostFunction('ferr', (() => { throw new Error('error'); }), { returns: 'async' });
            rpc1.sendRemoteDescriptors();

            const proxyFunc = rpc2.getProxyObject('ferr');
            await expect(proxyFunc()).rejects.toMatch('error');
        });
    });

    describe('proxy objects', () => {
        test('object died', async () => {
            class A {}
            const aInstance = new A();
            const fInstance = jest.fn();

            rpc1.registerHostClass('A', A, {});
            rpc1.registerHostObject('objA', {
                getA() {
                    return aInstance;
                },
                getF() {
                    return fInstance;
                }
            }, {
                functions: ['getA', 'getF']
            });
            rpc1.sendRemoteDescriptors();

            const proxyObj = rpc2.getProxyObject('objA');
            const proxyA = await proxyObj.getA();
            proxyA[rpc_disposeFunc]();

            const proxyF = await proxyObj.getF();

            proxyF[rpc_disposeFunc]();

            await expect(proxyF()).rejects.toThrowError();
        });

        test('Promise ping-pong', async () => {
            const giveMeAPromise = (fn: (p:Promise<string>) => Promise<void>) => fn(Promise.resolve('done'));
            rpc1.registerHostFunction('fpromise', giveMeAPromise, { });
            rpc1.sendRemoteDescriptors();

            const proxyGiveMeAPromise = rpc2.getProxyObject('fpromise');

            const result = await proxyGiveMeAPromise(async (p: Promise<string>) => ('well' + await p));
            expect(result).toEqual('welldone');
        });

        test('Promise ping-boom', async () => {
            const giveMeAPromise = (fn: (p:Promise<string>) => Promise<void>) => fn(Promise.reject('BOOM'));
            rpc1.registerHostFunction('fpromise2', giveMeAPromise, { });
            rpc1.sendRemoteDescriptors();

            const proxyGiveMeAPromise = rpc2.getProxyObject('fpromise2');
            await expect(proxyGiveMeAPromise(async (p: Promise<string>) => ('well' + await p))).rejects.toMatch('BOOM');
        });

        test('sending back a proxy obj/func', async () => {
            expect.assertions(2);
            class A {}
            const aInstance = new A();
            const fInstance = jest.fn();

            rpc1.registerHostClass('A', A, {});
            rpc1.registerHostObject('objA', {
                getA() {
                    return aInstance;
                },
                getF() {
                    return fInstance;
                },
                setA(a: A) {
                    expect(a).toBe(aInstance);
                },
                setF(f: () => void) {
                    expect(f).toBe(fInstance);
                }
            }, {
                functions: ['getA', 'getF', 'setA', 'setF']
            });
            rpc1.sendRemoteDescriptors();

            const proxyObj = rpc2.getProxyObject('objA');
            const proxyA = await proxyObj.getA();
            await proxyObj.setA(proxyA);

            const proxyF = await proxyObj.getF();
            await proxyObj.setF(proxyF);
        });

        test('proxy object in a response object', async () => {
            expect.assertions(1);
            class A {}
            const aInstance = new A();

            rpc1.registerHostClass('A', A, {});
            rpc1.registerHostObject('objA', {
                getA() {
                    return aInstance;
                },
                setA(obj: { a: A }) {
                    expect(obj.a).toBe(aInstance);
                }
            }, {
                functions: ['getA', 'setA']
            });
            rpc1.sendRemoteDescriptors();

            const proxyObj = rpc2.getProxyObject('objA');
            const proxyA = await proxyObj.getA();
            await proxyObj.setA({ a: proxyA });
        });
    });
});
