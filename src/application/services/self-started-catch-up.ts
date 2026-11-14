/**
 * Sessions a VM's agent started by itself while the Mac was away (#438,
 * #442): the fix errands of a VM that merges. Nobody on the Mac opened them,
 * so the Mac has no row for them; Open errand on the Merge manager's page and
 * the away summary would lead nowhere.
 *
 * On every connect, and whenever the Merging host reads the VM's lanes, the
 * agent is asked for them (`list-self-started`). Each one gets a session
 * record on the VM project holding its folder, the copy whose worktree it
 * runs in, which is registered first when the agent made that copy itself.
 * Then the agent is told to forget them (`forget-self-started`). Like the
 * self-archive catch-up, only an agent at the app's own version is asked.
 */
import {remoteProjectPath} from '../../domain/project/remote-target';
import type {SelfStartedSession} from '../../domain/agent/protocol';
import type {VmHost} from '../../domain/agent/vm-paths';
import type {Logger} from '../ports/logger';
import type {RendererGateway} from '../ports/renderer-gateway';
import type {SettingsService} from './settings-service';
import {WORKTREES_DIR} from './support/branch-worktrees';

export interface SelfStartedLink {
    readonly host: VmHost;
    readonly home: string | null;
    readonly agentVersion: string | null;
    listSelfStarted(): Promise<SelfStartedSession[]>;
    forgetSelfStarted(sessionIds: string[]): Promise<{ok: boolean}>;
}

export interface SelfStartedCatchUpDeps {
    settings: Pick<SettingsService, 'remoteProjects' | 'addRemoteProject' | 'touchRemoteSession'>;
    renderer: Pick<RendererGateway, 'projectsChanged'>;
    appVersion: string;
    log: Logger;
}

/** The project folder a self-started session belongs to: the copy whose worktree it runs in, `~` form. */
export function selfStartedProjectDir(cwd: string, home: string | null): string {
    const clean = cwd.replace(/\/+$/, '');
    const at = clean.indexOf(WORKTREES_DIR);
    const copy = at >= 0 ? clean.slice(0, at) : clean;
    const root = home?.replace(/\/+$/, '');
    if (root && (copy === root || copy.startsWith(root + '/'))) return '~' + copy.slice(root.length);
    return copy;
}

export class SelfStartedCatchUp {
    private readonly running = new Set<string>();

    constructor(private readonly deps: SelfStartedCatchUpDeps) {}

    /** Ask the VM for the sessions it started by itself, record each, then let the VM forget them. */
    public async catchUp(link: SelfStartedLink): Promise<void> {
        const {settings, log} = this.deps;
        if (link.agentVersion !== this.deps.appVersion) return;
        const key = `${link.host.user}@${link.host.host}:${link.host.port}`;
        if (this.running.has(key)) return;
        this.running.add(key);
        try {
            const sessions = await link.listSelfStarted();
            if (sessions.length === 0) return;
            const handled: string[] = [];
            for (const session of sessions) {
                const dir = selfStartedProjectDir(session.cwd, link.home);
                const project = {user: link.host.user, host: link.host.host, port: link.host.port, dir};
                const projectPath = remoteProjectPath(project);
                if (!settings.remoteProjects().some((remote) => remoteProjectPath(remote) === projectPath)) {
                    settings.addRemoteProject(project);
                }
                if (
                    settings.touchRemoteSession(
                        projectPath,
                        session.sessionId,
                        'claude',
                        new Date(session.startedAt).toISOString(),
                    )
                ) {
                    handled.push(session.sessionId);
                }
            }
            if (handled.length === 0) return;
            await link.forgetSelfStarted(handled);
            log.info(`[self-started] ${handled.length} session(s) the agent on ${key} started by itself recorded`);
            this.deps.renderer.projectsChanged();
        } catch (err) {
            log.warn(`[self-started] catching up with ${key} failed: ${(err as Error).message}`);
        } finally {
            this.running.delete(key);
        }
    }
}
