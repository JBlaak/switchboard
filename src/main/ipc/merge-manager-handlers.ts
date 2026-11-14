/**
 * The Merge manager (#434): its lanes, Land and Unland from the renderer, and
 * Try again on a fix errand that gave up (#437), and what its page shows
 * besides the lanes (#439), and moving merging to a VM and back (#442),
 * all through the Merging host. Setting a PR aside and
 * linking its errand are main's own, from the lane runner and the fix errands
 * (#435, #437).
 */
import {INVOKE} from '../../ipc/channels';
import type {Container} from '../composition-root';
import type {IpcRegistrar} from './support/registrar';

export function registerMergeManagerHandlers(ipc: IpcRegistrar, app: Container): void {
    // Through the Merging host (#442): answered here, or forwarded to the VM that merges.
    ipc.handle(INVOKE.mergeManagerState, () => app.mergingHost.state());
    ipc.handle(INVOKE.mergeManagerLand, (repository: unknown, number: unknown) =>
        app.mergingHost.land(asRepository(repository), asNumber(number)),
    );
    ipc.handle(INVOKE.mergeManagerUnland, (repository: unknown, number: unknown) =>
        app.mergingHost.unland(asRepository(repository), asNumber(number)),
    );
    ipc.handle(INVOKE.mergeManagerTryAgain, (repository: unknown, number: unknown, note: unknown) =>
        app.mergingHost.tryAgain(asRepository(repository), asNumber(number), typeof note === 'string' ? note : null),
    );
    ipc.handle(INVOKE.mergeManagerPage, () => app.mergingHost.pageFacts());
    ipc.handle(INVOKE.mergeManagerHandOff, (vmKey: unknown) =>
        app.mergingHost.handOff(typeof vmKey === 'string' && vmKey ? vmKey : undefined),
    );
    ipc.handle(INVOKE.mergeManagerBringBack, () => app.mergingHost.bringBack());
    ipc.handle(INVOKE.mergeManagerTakeBack, () => app.mergingHost.takeBackAnyway());
    ipc.handle(INVOKE.mergeManagerReconnect, () => app.mergingHost.reconnect());
    ipc.handle(INVOKE.mergeManagerDismissAway, () => app.mergingHost.dismissSummary());
}

function asRepository(repository: unknown): string {
    if (typeof repository !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(repository)) {
        throw new Error('a repository is owner/repo');
    }
    return repository;
}

function asNumber(number: unknown): number {
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) {
        throw new Error('a pull request number is a positive whole number');
    }
    return number;
}
