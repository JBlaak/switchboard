/**
 * Forgetting a remote project: its setting, and the sessions this app holds
 * for it. Shared by the Projects list's Remove, by removing a VM copy, and by
 * removing a VM from Settings → VMs (#276).
 *
 * A session on a VM's agent is only forgotten here, never signalled, as
 * quitting does (`SessionLifecycle.terminateAll`): outliving the Mac app is
 * the point of running it there, and forgetting a project here is not asking
 * the VM to stop anything. Its record is retired locally and the agent client
 * lets go of its stand-in; the session goes on running on the VM, and adding
 * the project back (or registering the VM again) reattaches it. An agentless
 * remote's session is a local ssh process attached to tmux, and is stopped as
 * before.
 */
import {isAgentPty} from '../application/services/agent-client/agent-pty';
import type {Container} from './composition-root';

/** The parts of the container this uses; narrowed so a test can hand in fakes. */
export interface ForgetDeps {
    settings: Pick<Container['settings'], 'removeRemoteProject'>;
    registry: Pick<Container['registry'], 'snapshot'>;
    remote: Pick<Container['remote'], 'markDisconnected'>;
    lifecycle: Pick<Container['lifecycle'], 'retire' | 'stop'>;
    renderer: Pick<Container['renderer'], 'projectsChanged'>;
    agents: Pick<Container['agents'], 'release'>;
}

export function forgetRemoteProject(app: ForgetDeps, projectPath: string): void {
    app.settings.removeRemoteProject(projectPath);

    for (const [sessionId, session] of app.registry.snapshot()) {
        if (session.projectPath !== projectPath) continue;
        app.remote.markDisconnected(session);
        if (isAgentPty(session.pty)) {
            app.agents.release(session.pty);
            app.lifecycle.retire(sessionId, session, 0);
        } else if (session.exited) {
            app.lifecycle.retire(sessionId, session, 0);
        } else {
            app.lifecycle.stop(sessionId, session);
        }
    }

    app.renderer.projectsChanged();
}
