export const rpc_disposed = Symbol('rpc_disposed');
export const rpc_disposeFunc = Symbol('rpc_dispose');

/**
 * Stores proxy objects/functions that represent remote objects - **used internally**.
 *
 * On the other side the corresponding "host" object/function is held in a registry by a strong reference,
 * and in order to be able to remove it and not leak the reference, we need a way to inform the other side
 * when the proxy object is "no longer used". For this we use the WeakRef and FinalizationRegistry features.
 *
 * We hold the proxy object/function with a weak reference, and when it is garbage collected, we can be sure that
 * it will not be used (called) anymore, so we remove it from our object registry and send a message
 * to the other side to remove the corresponding local object from the hostObjectRegistry as well.
 * @module
 * @internal
 */
export class ProxyObjectRegistry {
    private readonly registry = new Map<string, WeakRef<any>>();
    private readonly objectFinalized = new FinalizationRegistry((rpc_dispose: () => void) => rpc_dispose());

    /**
     * Register an object.
     * @param dispose Called when the object is removed from the registry (either explicitly or by the GC)
     */
    public register(objId: string, obj: any, dispose?: () => void) {
        const unregToken = {};
        obj[rpc_disposed] = false;
        obj[rpc_disposeFunc] = () => {
            this.remoteObjectDisposed(objId, unregToken);
            obj[rpc_disposed] = true;
            dispose?.();
        };
        this.objectFinalized.register(obj, obj[rpc_disposeFunc], unregToken);
        this.registry.set(objId, new WeakRef(obj));
    }

    public has(objId: string) {
        return this.registry.has(objId);
    }

    public delete(objId: string) {
        this.registry.delete(objId);
    }

    public get(objId: string) {
        return this.registry.get(objId)?.deref();
    }

    private remoteObjectDisposed(objId: string, uregToken: object) {
        this.objectFinalized.unregister(uregToken);
        this.registry.delete(objId);
    }

}