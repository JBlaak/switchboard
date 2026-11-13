/**
 * Settings → Bug manager (#411): the Bugsnag token, the projects it sees and
 * their opt-in and link, the trending thresholds.
 *
 * The token comes in on `bugsnagSaveToken` and never goes back out: every
 * answer is a `BugsnagConnectionView`, which holds only its last four characters.
 */
import {INVOKE} from '../../ipc/channels';
import type {BugsnagProjectChange} from '../../domain/bugsnag/connection';
import type {Container} from '../composition-root';
import type {IpcRegistrar} from './support/registrar';

export function registerBugsnagHandlers(ipc: IpcRegistrar, app: Container): void {
    ipc.handle(INVOKE.bugsnagConnection, () => app.bugsnag.view());
    ipc.handle(INVOKE.bugsnagSaveToken, (token: unknown) => {
        if (typeof token !== 'string') throw new Error('a token is text');
        return app.bugsnag.saveToken(token);
    });
    ipc.handle(INVOKE.bugsnagRemoveToken, () => app.bugsnag.removeToken());
    ipc.handle(INVOKE.bugsnagSetProject, (id: unknown, change: unknown, name: unknown) => {
        if (typeof id !== 'string' || id === '') throw new Error('a Bugsnag project id is text');
        app.bugsnag.setProject(id, asChange(change), typeof name === 'string' ? name : undefined);
        return {ok: true};
    });
    ipc.handle(INVOKE.bugsnagSetTrending, (trending: unknown) => app.bugsnag.setTrending(trending));
}

/** A project change from the renderer, keeping only the fields it may set. */
function asChange(value: unknown): BugsnagProjectChange {
    const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
    const change: BugsnagProjectChange = {};
    if (typeof raw.optedIn === 'boolean') change.optedIn = raw.optedIn;
    if (raw.localProject === null || typeof raw.localProject === 'string') change.localProject = raw.localProject;
    return change;
}
