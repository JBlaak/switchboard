/**
 * Forgetting a remote project: its setting, and the sessions this app holds
 * for it. Shared by the Projects list's Remove and by removing a VM copy (#276).
 */
import type {Container} from './composition-root';

type ForgetDeps = Pick<Container, 'settings' | 'registry' | 'remote' | 'lifecycle' | 'renderer'>;

export function forgetRemoteProject(app: ForgetDeps, projectPath: string): void {
    app.settings.removeRemoteProject(projectPath);

    for (const [sessionId, session] of app.registry.snapshot()) {
        if (session.projectPath !== projectPath) continue;
        app.remote.markDisconnected(session);
        if (session.exited) {
            app.lifecycle.retire(sessionId, session, 0);
        } else {
            app.lifecycle.stop(sessionId, session);
        }
    }

    app.renderer.projectsChanged();
}
