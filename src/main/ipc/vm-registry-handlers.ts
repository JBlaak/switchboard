/**
 * Settings → VMs (#276, #307): listing, registering, renaming and removing
 * VMs, as phones are paired.
 *
 * Every call goes to the `VmRegistry` façade. What arrives from the renderer
 * is checked for shape here, so the façade only ever sees strings and
 * numbers; the address itself is the façade's to validate, since its message
 * is what the form shows. Installing and the host's settings stay on the
 * `agent:*` channels, which take the VM's `vmHostPath`.
 */
import {INVOKE} from '../../ipc/channels';
import type {VmRegistry} from '../../application/services/vm-registry';
import type {Container} from '../composition-root';
import type {IpcRegistrar} from './support/registrar';

/** The fields of an Add a VM form, typed; anything else the renderer sent is dropped. */
function addInput(input: unknown): {user: string; host: string; port?: number; name?: string} {
    const fields = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    const port =
        typeof fields.port === 'number' ? fields.port : typeof fields.port === 'string' ? Number(fields.port) : NaN;
    return {
        user: typeof fields.user === 'string' ? fields.user : '',
        host: typeof fields.host === 'string' ? fields.host : '',
        // An empty or absent port is ssh's 22; a typed one that isn't a number is refused by validation.
        ...(fields.port === undefined || fields.port === null || fields.port === '' ? {} : {port}),
        ...(typeof fields.name === 'string' ? {name: fields.name} : {}),
    };
}

/** The façade, until the composition root builds one; a call before then fails with this. */
function registryOf(app: Container): VmRegistry {
    if (!app.vmRegistry) throw new Error('VMs aren’t available in this build');
    return app.vmRegistry;
}

export function registerVmRegistryHandlers(ipc: IpcRegistrar, app: Container): void {
    ipc.handle(INVOKE.vmRegistryList, () => (app.vmRegistry ? app.vmRegistry.list() : []));

    ipc.handle(INVOKE.vmRegistryAdd, (input: unknown) => registryOf(app).add(addInput(input)));

    ipc.handle(INVOKE.vmRegistryRename, (key: unknown, name: unknown) =>
        typeof key === 'string' && typeof name === 'string' ? registryOf(app).rename(key, name) : false,
    );

    ipc.handle(INVOKE.vmRegistryRemove, (key: unknown) =>
        typeof key === 'string' ? registryOf(app).remove(key) : {ok: false, error: 'Not a VM'},
    );
}
