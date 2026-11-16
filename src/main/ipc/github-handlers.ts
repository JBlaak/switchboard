/**
 * GitHub's GraphQL budget: until when expensive reads are held back, read
 * once at launch; every change after is pushed (`githubBudgetHeld`).
 */
import {INVOKE} from '../../ipc/channels';
import type {Container} from '../composition-root';
import type {IpcRegistrar} from './support/registrar';

export function registerGithubHandlers(ipc: IpcRegistrar, app: Container): void {
    ipc.handle(INVOKE.githubHeldUntil, () => app.githubHeldUntil());
}
