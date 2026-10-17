/**
 * The Plan tab (#121): a session's plans, one plan by its issue, and a
 * project's plans for the picker. Reads only; each is kept for 30 s in main.
 */
import { INVOKE } from '../../ipc/channels';
import type { Container } from '../composition-root';
import type { IpcRegistrar } from './registrar';

export function registerPlanHandlers(ipc: IpcRegistrar, app: Container): void {
  ipc.handle(INVOKE.planSessionPlans, (sessionId: string) => app.plans.sessionPlans(String(sessionId)));
  ipc.handle(INVOKE.planGet, (repo: string, number: number) =>
    typeof number === 'number' ? app.plans.plan(String(repo), number) : null);
  ipc.handle(INVOKE.planProjectPlans, (projectPath: string, options?: { closed?: unknown }) =>
    app.plans.projectPlans(String(projectPath), { closed: options?.closed === true }));
}
