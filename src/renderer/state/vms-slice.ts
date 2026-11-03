/**
 * Settings → VMs as the renderer shows them (#307): the registered VMs, as
 * main lists them, which one is open to its controls, and a call that
 * failed.
 *
 * The list is main's, read whole at launch, whenever the settings open and on
 * every `onVmHostsChanged`. Until the first answer it is null, which the
 * section shows as no VMs and a project page as its host's address.
 *
 * The open VM is the renderer's own: a click on its row, a VM just added, or
 * a project page's "Manage in Settings". It closes when the VM leaves the
 * list.
 *
 * Each VM's controls (install, setup, host settings) are the agent host
 * slice's, keyed by the same VM key.
 *
 * The events are declared here rather than in `events.ts`, like the phone
 * access ones; `events.ts` folds them into the union.
 */
import type {VmHostView} from '../../application/services/vm-registry';
import type {RendererEvent} from './events';

/** What the renderer asked main to do, for the copy of a call that failed. */
export type VmCall = 'load' | 'add' | 'rename' | 'remove' | 'register';

export type VmsEvent =
    /** Main's list, read or pushed. */
    | {type: 'vmHostsLoaded'; hosts: readonly VmHostView[]}
    /** A VM opened to its controls (a row's click, Manage in Settings), or null to close it. */
    | {type: 'vmHostOpened'; key: string | null}
    /** A call went out; why the same kind of call failed before is cleared. */
    | {type: 'vmCallStarted'; call: VmCall}
    /** Add a VM (or Register this host as a VM) took it; it opens, with Install agent ready. */
    | {type: 'vmHostAdded'; key: string}
    | {type: 'vmCallFailed'; call: VmCall; message: string};

export interface VmsState {
    /** Null until main has answered. */
    readonly hosts: readonly VmHostView[] | null;
    /** The VM whose controls show. */
    readonly open: string | null;
    readonly failure: {readonly call: VmCall; readonly message: string} | null;
}

export const initialVmsState: VmsState = {hosts: null, open: null, failure: null};

export function vmsReducer(state: VmsState, event: RendererEvent): VmsState {
    switch (event.type) {
        case 'vmHostsLoaded': {
            const hosts = event.hosts;
            // A VM that was listed and is gone was removed; one just added may not be listed yet.
            const gone =
                state.open !== null &&
                !!state.hosts?.some((vm) => vm.key === state.open) &&
                !hosts.some((vm) => vm.key === state.open);
            return {...state, hosts, open: gone ? null : state.open};
        }

        case 'vmHostOpened':
            return state.open === event.key ? state : {...state, open: event.key};

        case 'vmCallStarted':
            return state.failure?.call === event.call ? {...state, failure: null} : state;

        case 'vmHostAdded':
            return {...state, open: event.key, failure: null};

        case 'vmCallFailed':
            return {...state, failure: {call: event.call, message: event.message}};

        default:
            return state;
    }
}

// ── What the surfaces read ──

/** The VMs to list, in main's order; none until main has answered. */
export function vmHostsIn(state: VmsState): readonly VmHostView[] {
    return state.hosts ?? [];
}

/** Why the last call of this kind failed, if it did. */
export function vmFailureIn(state: VmsState, call: VmCall): string | null {
    return state.failure?.call === call ? state.failure.message : null;
}
