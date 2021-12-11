export class RemoteObjectRegistry {
    private readonly registry = new Map<string, WeakRef<any>>();
    private readonly objectFinalized = new FinalizationRegistry((rpc_dispose: () => void) => rpc_dispose());

    public register(objId: string, obj: any, dispose?: () => void) {
        const unregToken = {};
        obj.rpc_disposed = false;
        obj.rpc_dispose = () => { 
            this.remoteObjectDisposed(objId, unregToken);
            obj.rpc_disposed = true;
            dispose?.(); 
        };
        this.objectFinalized.register(obj, obj.rpc_dispose, unregToken);
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