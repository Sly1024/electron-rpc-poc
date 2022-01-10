import { ProxyObjectRegistry, rpc_disposeFunc } from '../proxy-object-registry';

describe('ProxyObjectRegistry', () => {
    const registry = new ProxyObjectRegistry();

    test('register/delete', () => {
        const obj1 = {};
        const obj2 = {};

        registry.register('one', obj1);
        registry.register('two', obj2);

        expect(registry.has('one')).toBeTruthy();
        expect(registry.get('one')).toBe(obj1);

        registry.delete('one');

        expect(registry.has('one')).toBeFalsy();
        expect(registry.get('one')).toBeUndefined();

        expect(registry.get('two')).toBe(obj2);
    });

    test('no dispose', () => {
        const obj1: any = {};
        const obj2: any = {};

        registry.register('one', obj1);
        registry.register('two', obj2);

        obj1[rpc_disposeFunc]();

        expect(registry.get('one')).toBeUndefined();
        expect(registry.get('two')).toBe(obj2);

        obj2[rpc_disposeFunc]();
        expect(registry.get('two')).toBeUndefined();
    });

    test('custom dispose', () => {
        const obj1: any = {};
        const obj2: any = {};

        const obj1dispose = jest.fn();
        const obj2dispose = jest.fn();

        registry.register('one', obj1, obj1dispose);
        registry.register('two', obj2, obj2dispose);

        obj1[rpc_disposeFunc]();

        expect(registry.get('one')).toBeUndefined();
        expect(obj1dispose).toHaveBeenCalled();
        expect(obj2dispose).not.toHaveBeenCalled();

        obj2[rpc_disposeFunc]();
        expect(registry.get('two')).toBeUndefined();
        expect(obj2dispose).toHaveBeenCalled();
    });

});