/**
 * The Merge manager (#434): its lanes, Land and Unland from the renderer, and
 * Try again on a fix errand that gave up (#437). Setting a PR aside and
 * linking its errand are main's own, from the lane runner and the fix errands
 * (#435, #437).
 */
import {INVOKE} from '../../ipc/channels';
import type {Container} from '../composition-root';
import type {IpcRegistrar} from './support/registrar';

export function registerMergeManagerHandlers(ipc: IpcRegistrar, app: Container): void {
    ipc.handle(INVOKE.mergeManagerState, () => app.mergeManager.state());
    ipc.handle(INVOKE.mergeManagerLand, (repository: unknown, number: unknown) =>
        app.mergeManager.land(asRepository(repository), asNumber(number)),
    );
    ipc.handle(INVOKE.mergeManagerUnland, (repository: unknown, number: unknown) =>
        app.mergeManager.unland(asRepository(repository), asNumber(number)),
    );
    ipc.handle(INVOKE.mergeManagerTryAgain, (repository: unknown, number: unknown, note: unknown) =>
        app.fixErrands.tryAgain(asRepository(repository), asNumber(number), typeof note === 'string' ? note : null),
    );
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
