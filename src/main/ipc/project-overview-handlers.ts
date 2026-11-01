/**
 * The project page (#172): everything it shows that main knows, in one answer.
 * Reads only; the GitHub part is kept for 30 s in main. Asked with
 * `plans: false`, the answer comes without the plans, which take longest.
 */
import {INVOKE} from '../../ipc/channels';
import type {Container} from '../composition-root';
import type {IpcRegistrar} from './support/registrar';

export function registerProjectOverviewHandlers(ipc: IpcRegistrar, app: Container): void {
    ipc.handle(
        INVOKE.projectOverview,
        (projectPath: string, options?: {closed?: unknown; merged?: unknown; plans?: unknown}) =>
            app.projectOverview.overview(String(projectPath), {
                closed: options?.closed === true,
                merged: options?.merged === true,
                plans: options?.plans !== false,
            }),
    );
}
