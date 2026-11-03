/**
 * Settings → VMs' calls to main (#307), in one place.
 *
 * INTEGRATOR: REPLACE THIS SHIM. The VM registry's IPC (`vmHosts`,
 * `addVmHost`, `renameVmHost`, `removeVmHost`, `onVmHostsChanged`) is built
 * on the main side in parallel, so `SwitchboardApi` doesn't declare it yet.
 * Until it does, `VmHostsApi` declares those preload methods here and
 * `vmApi()` casts `window.api` to it. Once `src/ipc/api.ts` has them, delete
 * `VmHostsApi` and have `vmApi()` answer `window.api` itself (or call
 * `window.api` directly at the call sites). Every other file reaches the
 * registry only through `vmApi()`.
 */
import type {VmHostView} from '../../../application/services/vm-registry';
import type {Unsubscribe} from '../../../ipc/api';

export type {VmHostView};

export type AddVmHostResult = {ok: true; key: string} | {ok: false; error: string};

/** The preload's VM registry methods, as the main side adds them. */
export interface VmHostsApi {
    vmHosts(): Promise<VmHostView[]>;
    addVmHost(input: {user: string; host: string; port?: number; name?: string}): Promise<AddVmHostResult>;
    /** Answers whether the name was kept; a refusal may also come as `{ok: false, error}`. */
    renameVmHost(key: string, name: string): Promise<unknown>;
    removeVmHost(key: string): Promise<{ok: true} | {ok: false; error: string}>;
    /** Main's push on every change; it may carry the new list, or nothing and the list is read again. */
    onVmHostsChanged(cb: (hosts?: VmHostView[]) => void): Unsubscribe;
}

export function vmApi(): VmHostsApi {
    return window.api as unknown as VmHostsApi;
}
