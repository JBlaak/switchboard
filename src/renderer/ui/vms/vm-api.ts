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

export type {VmHostView};

export type AddVmHostResult = {ok: true; key: string} | {ok: false; error: string};

/** The preload's VM registry methods, as the main side adds them. */
/** The VM registry's calls, as the preload exposes them (#307). */
export type VmHostsApi = Pick<
    typeof window.api,
    'vmHosts' | 'addVmHost' | 'renameVmHost' | 'removeVmHost' | 'onVmHostsChanged'
>;

export function vmApi(): VmHostsApi {
    return window.api;
}
