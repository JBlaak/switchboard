/**
 * Main's VM side (#276) for component specs: the registered VMs, their agent,
 * a project's hand-off and its copies, a session's hand-off and Bring back,
 * where schedules run, and files dropped on a VM terminal.
 *
 * Each part answers as the e2e host stubs do (e2e/support/main-process.ts),
 * from the same stub shapes and defaults (`STUB_AGENT`, `STUB_HANDOFF`, …),
 * read at each call so a test can swap one mid-way as `setHostStub` did. The
 * registry is the exception: e2e ran the real one, so this one keeps its rules
 * (a VM's projects are the remotes on its host, removing it forgets them) over
 * the `MainWorld`'s projects.
 */
import type {FakeApi} from './fake-api';
import type {MainWorld} from './main-world';
import {
    STUB_AGENT,
    STUB_HANDOFF,
    STUB_SESSION_BRING_BACK,
    STUB_SESSION_HANDOFF,
    type AgentStub,
    type DroppedFilesStub,
    type HandoffStub,
    type SessionBringBackStub,
    type SessionHandoffStub,
    type VmSchedulesStub,
} from '../../e2e/support/main-process';
import {parseRemoteProjectPath} from '../../src/domain/project/remote-target';
import type {VmHostView} from '../../src/application/services/vm-registry';
import type {SessionBringBackPhase} from '../../src/application/services/session-bring-back';
import type {SessionHandoffPhase} from '../../src/application/services/session-handoff';

/** A registered VM as the real registry keeps it; its projects are worked out from the world's. */
export type VmEntry = Omit<VmHostView, 'projects'>;

/** A VM entry for `user@host[:port]`: no name, no agent yet. */
export function vmEntry(user: string, host: string, port = 22, change: Partial<VmEntry> = {}): VmEntry {
    return {
        key: `${user}@${host}:${port}`,
        user,
        host,
        port,
        label: address(user, host, port),
        agent: null,
        current: false,
        connected: false,
        ...change,
    };
}

function address(user: string, host: string, port: number): string {
    return `${user}@${host}${port === 22 ? '' : ':' + port}`;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class VmMain {
    public vms: VmEntry[] = [];
    public agent: AgentStub = structuredClone(STUB_AGENT);
    public handoff: HandoffStub = {...structuredClone(STUB_HANDOFF), hosts: []};
    public sessionHandoff: SessionHandoffStub = structuredClone(STUB_SESSION_HANDOFF);
    public sessionBringBack: SessionBringBackStub = structuredClone(STUB_SESSION_BRING_BACK);
    public vmSchedules: VmSchedulesStub = {where: {}, runOn: {error: 'No VM in the harness'}};
    public droppedFiles: DroppedFilesStub = {result: {ok: false, error: 'No VM in the harness'}};
    private readonly waiting = new Map<string, () => void>();

    constructor(
        private readonly api: FakeApi,
        private readonly world: MainWorld,
    ) {}

    /** The registry's list: each VM with the world's projects on its host. */
    public hosts(): VmHostView[] {
        return this.vms.map((vm) => ({
            ...vm,
            projects: this.world.projectPaths().filter((path) => {
                const remote = parseRemoteProjectPath(path);
                return remote && remote.user === vm.user && remote.host === vm.host && remote.port === vm.port;
            }),
        }));
    }

    /** Push an event after the call that caused it has answered, as main's `webContents.send` lands. */
    private later(push: () => Promise<void>): void {
        setTimeout(() => void push().catch(() => {}), 0);
    }

    public install(): this {
        const {api} = this;

        // The registry.
        api.handle('vmHosts', () => this.hosts());
        api.handle('addVmHost', (input) => {
            const port = Number(input.port) || 22;
            const key = `${input.user}@${input.host}:${port}`;
            if (this.vms.some((vm) => vm.key === key)) {
                return {ok: false as const, error: `${address(input.user, input.host, port)} is already registered.`};
            }
            this.vms.push(vmEntry(input.user, input.host, port, input.name ? {label: input.name} : {}));
            this.later(() => api.emit('onVmHostsChanged'));
            return {ok: true as const, key};
        });
        api.handle('renameVmHost', (key, name) => {
            const vm = this.vms.find((host) => host.key === key);
            if (!vm) return false;
            vm.label = String(name) || address(vm.user, vm.host, vm.port);
            this.later(() => api.emit('onVmHostsChanged'));
            return true;
        });
        api.handle('removeVmHost', (key) => {
            const vm = this.hosts().find((host) => host.key === key);
            if (!vm) return {ok: false as const, error: `${key} is not a registered VM.`};
            this.vms = this.vms.filter((host) => host.key !== key);
            this.world.projects = this.world.projects.filter((project) => !vm.projects.includes(project.projectPath));
            this.later(async () => {
                await api.emit('onVmHostsChanged');
                await api.emit('onProjectsChanged');
            });
            return {ok: true as const};
        });

        // The agent, for every host alike.
        api.handle('agentStatus', () => this.agent.status);
        api.handle('installAgent', async (projectPath) => {
            for (const line of this.agent.installLines) {
                await pause(this.agent.installLineDelayMs);
                await api.emit('onAgentInstallProgress', projectPath, line);
            }
            const remote = parseRemoteProjectPath(projectPath);
            const vm = this.vms.find(
                (host) => remote && host.user === remote.user && host.host === remote.host && host.port === remote.port,
            );
            if (this.agent.installResult.ok && vm) {
                vm.agent = this.agent.status.installed;
                vm.current = this.agent.status.current;
                vm.connected = this.agent.status.connected;
                this.later(() => api.emit('onVmHostsChanged'));
            }
            return this.agent.installResult;
        });
        api.handle('checkAgentTools', () => this.agent.tools);
        api.handle('agentHostSettings', () => this.agent.hostSettings);
        api.handle('setAgentHostSettings', (_projectPath, change) => {
            if (!this.agent.hostSettings) return null;
            this.agent = {...this.agent, hostSettings: {...this.agent.hostSettings, ...change}};
            return this.agent.hostSettings;
        });
        api.handle('openAgentSetupTerminal', () => this.agent.setupTerminal);

        // A project's hand-off and its copies.
        api.handle('handoffHosts', () => this.handoff.hosts);
        api.handle('previewHandoff', () => this.handoff.preview);
        api.handle('handOffProject', async (localPath) => {
            for (const line of this.handoff.lines) {
                await pause(this.handoff.lineDelayMs);
                await api.emit('onHandoffProgress', localPath, line);
            }
            return this.handoff.result;
        });
        api.handle('handOffForStart', async (localPath) => {
            for (const line of this.handoff.lines) {
                await pause(this.handoff.lineDelayMs);
                await api.emit('onHandoffProgress', localPath, line);
            }
            return this.handoff.startResult;
        });
        api.handle('projectCopies', (localPath) => this.handoff.copies[localPath] ?? []);
        api.handle('copyOrigin', (copyPath) => this.handoff.origins[copyPath] ?? null);
        api.handle('copyStatus', () => this.handoff.copyStatus);
        api.handle('bringBackCopy', async (copyPath) => {
            for (const line of this.handoff.bringBackLines) {
                await pause(this.handoff.lineDelayMs);
                await api.emit('onBringBackProgress', copyPath, line);
            }
            return this.handoff.bringBackResult;
        });
        api.handle('removeCopy', () => this.handoff.removeResult);

        // Where schedules run, and files dropped on a VM terminal.
        api.handle('schedulesWhere', (projectPath) => this.vmSchedules.where[projectPath] ?? null);
        api.handle('runSchedulesOn', () => this.vmSchedules.runOn);
        api.handle('uploadDroppedFiles', async () => {
            const {result, delayMs = 0} = this.droppedFiles;
            await pause(delayMs);
            return result;
        });

        // A session's hand-off: a `waiting` phase holds until its time is up or Cancel ends it.
        api.handle('previewSessionHandoff', () => this.sessionHandoff.preview);
        api.handle('handOffSession', async (sessionId) => {
            const stub = this.sessionHandoff;
            let last: SessionHandoffPhase = {kind: 'failed', error: 'The stub has no phases'};
            for (const phase of stub.phases) {
                await pause(stub.phaseDelayMs);
                await api.emit('onSessionHandoffPhase', sessionId, phase);
                last = phase;
                if (phase.kind !== 'waiting') continue;
                const cancelled = await new Promise<boolean>((resolve) => {
                    const timer = setTimeout(() => {
                        this.waiting.delete(sessionId);
                        resolve(false);
                    }, stub.waitingMs);
                    this.waiting.set(sessionId, () => {
                        clearTimeout(timer);
                        this.waiting.delete(sessionId);
                        resolve(true);
                    });
                });
                if (cancelled) {
                    last = {kind: 'cancelled'};
                    await api.emit('onSessionHandoffPhase', sessionId, last);
                    return last;
                }
            }
            if (last.kind === 'done') {
                const copyPath = last.copyPath;
                this.later(async () => {
                    await api.emit('onSessionStarted', sessionId, copyPath);
                    await api.emit('onProjectsChanged');
                });
            }
            return last;
        });
        api.handle('cancelSessionHandoff', (sessionId) => {
            const cancel = this.waiting.get(sessionId);
            if (!cancel) return false;
            cancel();
            return true;
        });

        // A VM session's Bring back.
        api.handle('previewSessionBringBack', () => this.sessionBringBack.preview);
        api.handle('bringBackSession', async (sessionId, existing) => {
            const stub = this.sessionBringBack;
            const choice = existing === 'reuse' || existing === 'replace' ? existing : 'none';
            let last: SessionBringBackPhase = {kind: 'failed', error: 'The stub has no phases'};
            for (const phase of stub.phases[choice]) {
                await pause(stub.phaseDelayMs);
                await api.emit('onSessionBringBackPhase', sessionId, phase);
                last = phase;
            }
            return last;
        });
        api.handle('cancelSessionBringBack', () => false);
        return this;
    }
}
