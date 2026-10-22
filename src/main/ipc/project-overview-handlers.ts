/**
 * The project page (#172): everything it shows that main knows, in one answer.
 * Reads only; the GitHub part is kept for 30 s in main.
 */
import { INVOKE } from '../../ipc/channels';
import type { Container } from '../composition-root';
import type { IpcRegistrar } from './registrar';

export function registerProjectOverviewHandlers(ipc: IpcRegistrar, app: Container): void {
  ipc.handle(INVOKE.projectOverview, (projectPath: string, options?: { closed?: unknown; merged?: unknown }) =>
    app.projectOverview.overview(String(projectPath), { closed: options?.closed === true, merged: options?.merged === true }));
}
