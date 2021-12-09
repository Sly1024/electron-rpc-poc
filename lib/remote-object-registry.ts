import { FunctionDescriptor, ObjectDescriptor, ObjectDescriptors } from './rpc-descriptor-types';

type RemoteObjectRegistryEntry = {
    descriptor: ObjectDescriptor | FunctionDescriptor;
    target: any;
    weakRef: false;
} | {
    descriptor: ObjectDescriptor | FunctionDescriptor;
    target: WeakRef<any>;
    weakRef: true;
};

export class RemoteObjectRegistry {
    private readonly registry = new Map<string, RemoteObjectRegistryEntry>();
    private readonly objectFinalized = new FinalizationRegistry((rpc_dispose: () => void) => rpc_dispose());

    public register(objId: string, obj: any, descriptor: FunctionDescriptor | ObjectDescriptor, 
        dispose?: () => void, weakRef = false)
    {
        const unregToken = {};
        obj.rpc_dispose = () => { this.remoteObjectDisposed(objId, unregToken); dispose?.(); };
        this.objectFinalized.register(obj, obj._rpc_dispose, unregToken);
        this.registry.set(objId, { descriptor, weakRef, target: weakRef ? new WeakRef(obj) : obj });
    }

    public has(objId: string) {
        return this.registry.has(objId);
    }
    
    public getObjectDescriptors(includeWeakRefs = false): ObjectDescriptors {
        const descriptors = {};
        for (const key of this.registry.keys()) {
            const entry = this.registry.get(key);
            if (includeWeakRefs || !entry.weakRef) descriptors[key] = entry.descriptor;
        }
        return descriptors;
    }

    public getObject(objId: string) {
        const entry = this.registry.get(objId);
        if (entry) {
            return { descriptor: entry.descriptor, target: entry.weakRef ? entry.target.deref() : entry.target };
        }
    }

    private remoteObjectDisposed(objId: string, uregToken: object) {
        this.objectFinalized.unregister(uregToken);
        this.registry.delete(objId);
    }
    
}