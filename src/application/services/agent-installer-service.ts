/**
 * Installing and upgrading the Switchboard agent on a VM over ssh (#276), the
 * `status` and `install` half of the `AgentHosts` façade.
 *
 * An install is a fixed sequence of small remote scripts (all in
 * `domain/agent/install-script.ts`), each one a named step that reports a
 * progress line, so a failure says which step broke and what the host said:
 *
 * 1. check the host, and refuse clearly when the agent can't run there
 * 2. when the agent there is already this app's version, only make sure it runs
 * 3. otherwise put the pinned Node there (downloaded on the VM, sum-checked)
 * 4. pack, upload and unpack this version's bundle, and switch `current`
 * 5. write the agent's command, its systemd unit and the setup script
 * 6. write the host settings, only when the host has none yet
 * 7. turn lingering on (or hand the user the command when that needs sudo)
 * 8. start the service (restarting it on an upgrade) and wait for its socket
 * 9. mark the remote as an agent host in settings, keeping its sessions
 *
 * The agent is always installed at the app's own version, so the Mac and the
 * VM never disagree about the protocol.
 */
import {AGENT_BIN, AGENT_NODE, AGENT_UNIT_FILE, HOST_SETTINGS_FILE} from '../../domain/agent/layout';
import type {AgentArch} from '../../domain/agent/layout';
import {DEFAULT_BASE_FOLDER, defaultHostInstructions} from '../../domain/agent/host-instructions';
import type {HostSettings} from '../../domain/agent/protocol';
import {
    agentBinScript,
    agentUnitFile,
    agentUnpackScript,
    agentUploadPath,
    hostCheckProblem,
    hostCheckScript,
    lingerCommand,
    lingerScript,
    nodeInstallScript,
    parseHostCheck,
    parseKeyValues,
    startServiceScript,
    writeFileIfMissingScript,
} from '../../domain/agent/install-script';
import type {HostCheck} from '../../domain/agent/install-script';
import {writeStdinToFileScript} from '../../domain/agent/ssh-provision';
import {SETUP_SCRIPT_FILE, setupScript} from '../../domain/agent/setup-script';
import type {RemoteConfig} from '../../domain/project/remote-target';
import type {RemoteProjectSetting} from '../../domain/settings/settings';
import type {RemoteRun, SshProvisioner} from '../ports/ssh-provisioner';
import type {Clock} from '../ports/clock';
import type {Logger} from '../ports/logger';
import type {AgentHostStatus, AgentHostsResult} from './agent-hosts';

/** Builds the bundle for one architecture and answers its local path. */
export interface AgentBundles {
    build(arch: AgentArch, version: string): Promise<string>;
}

/** The part of `SettingsService` the installer uses. */
export interface AgentInstallerSettings {
    findRemoteProject(projectPath: string): RemoteProjectSetting | null;
    markAgentInstalled(projectPath: string, version: string, installedAt?: string): boolean;
}

export interface AgentInstallerDeps {
    provisioner: SshProvisioner;
    settings: AgentInstallerSettings;
    bundles: AgentBundles;
    /** The app's version, which is the version installed. */
    appVersion: string;
    log: Logger;
    clock: Clock;
}

/**
 * What an install answers: the façade's result, plus the command the user has
 * to run themselves when lingering needs sudo the installer doesn't have. The
 * install still succeeds then; the agent runs for as long as someone is logged
 * in until that command is run (the setup terminal is the place for it).
 */
export interface AgentInstallResult extends AgentHostsResult {
    lingerCommand?: string;
}

/** Downloading Node over a slow link takes a while; the other steps are quick. */
const NODE_INSTALL_TIMEOUT_MS = 10 * 60_000;
const STEP_TIMEOUT_MS = 60_000;

/** A step that failed, with the message to show. */
class StepFailure extends Error {}

export class AgentInstallerService {
    constructor(private readonly deps: AgentInstallerDeps) {}

    /**
     * What settings know about the host's agent. No ssh: the project page asks
     * this every time it opens, and a connection may need the user to approve
     * a key (1Password's prompt) for nothing. `connected` is the live link's to
     * answer, so it is false here and the façade fills it in.
     */
    public status(projectPath: string): Promise<AgentHostStatus> {
        const installed = this.deps.settings.findRemoteProject(projectPath)?.agent?.version ?? null;
        return Promise.resolve({installed, current: installed === this.deps.appVersion, connected: false});
    }

    /** Install, upgrade, or just make sure the agent runs. Never rejects; a failure names its step. */
    public async install(
        projectPath: string,
        onProgress: (line: string) => void = () => {},
    ): Promise<AgentInstallResult> {
        const remote = this.deps.settings.findRemoteProject(projectPath);
        if (!remote) return {ok: false, error: `${projectPath} is not a configured SSH remote.`};
        const host: RemoteConfig = {user: remote.user, host: remote.host, port: remote.port};
        const version = this.deps.appVersion;
        const progress = (line: string) => {
            this.deps.log.info(`[agent-install] ${host.user}@${host.host}: ${line}`);
            onProgress(line);
        };

        try {
            const check = await this.step(progress, 'Checking the host', async () =>
                parseHostCheck((await this.run(host, hostCheckScript(), 'Checking the host')).stdout),
            );
            const problem = hostCheckProblem(check);
            if (problem) {
                progress(problem);
                return {ok: false, error: problem};
            }
            progress(describeHost(check));

            let manualLinger: string | undefined;
            if (check.agentVersion === version) {
                progress(`The agent is already at ${version}.`);
                await this.step(progress, 'Starting the agent', () =>
                    this.run(host, startServiceScript({restart: false}), 'Starting the agent'),
                );
            } else {
                manualLinger = (await this.fullInstall(host, check, progress)).lingerCommand;
            }
            this.mark(projectPath, progress);
            return manualLinger ? {ok: true, lingerCommand: manualLinger} : {ok: true};
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            this.deps.log.warn(`[agent-install] ${host.user}@${host.host} failed:`, error);
            return {ok: false, error};
        }
    }

    private async fullInstall(
        host: RemoteConfig,
        check: HostCheck,
        progress: (line: string) => void,
    ): Promise<{lingerCommand?: string}> {
        const version = this.deps.appVersion;
        const arch = check.arch as AgentArch;
        if (check.agentVersion) progress(`Upgrading the agent from ${check.agentVersion} to ${version}.`);

        await this.step(progress, `Installing Node ${AGENT_NODE.version}`, async () => {
            const r = await this.run(host, nodeInstallScript(arch), `Installing Node ${AGENT_NODE.version}`, {
                timeoutMs: NODE_INSTALL_TIMEOUT_MS,
            });
            if (parseKeyValues(r.stdout).node === 'present') progress(`Node ${AGENT_NODE.version} is already there.`);
        });

        const bundle = await this.step(progress, `Packing the agent ${version} for ${arch}`, () =>
            this.deps.bundles.build(arch, version),
        );
        const uploaded = agentUploadPath(version, arch);
        await this.step(progress, 'Uploading the agent', () =>
            this.deps.provisioner.upload(host, bundle, uploaded, 0o600),
        );
        await this.step(progress, 'Unpacking the agent', () =>
            this.run(host, agentUnpackScript(version, uploaded), 'Unpacking the agent'),
        );

        await this.step(progress, 'Writing the agent command', () =>
            this.run(host, writeStdinToFileScript(AGENT_BIN, 0o755), 'Writing the agent command', {
                stdin: agentBinScript(),
            }),
        );
        await this.step(progress, 'Writing the systemd unit', () =>
            this.run(host, writeStdinToFileScript(AGENT_UNIT_FILE, 0o644), 'Writing the systemd unit', {
                stdin: agentUnitFile(),
            }),
        );
        await this.step(progress, 'Writing the setup script', () =>
            this.run(host, writeStdinToFileScript(SETUP_SCRIPT_FILE, 0o755), 'Writing the setup script', {
                stdin: setupScript(),
            }),
        );

        await this.step(progress, 'Writing the host settings', async () => {
            const settings: HostSettings = {
                instructions: defaultHostInstructions({sudo: check.sudo}),
                copyConfig: true,
                baseFolder: DEFAULT_BASE_FOLDER,
            };
            const r = await this.run(
                host,
                writeFileIfMissingScript(HOST_SETTINGS_FILE, 0o600),
                'Writing the host settings',
                {
                    stdin: JSON.stringify(settings, null, 2) + '\n',
                },
            );
            if (parseKeyValues(r.stdout).written === 'no') progress('Kept the host settings already there.');
        });

        let manualLinger: string | undefined;
        await this.step(progress, 'Enabling lingering', async () => {
            const r = await this.run(host, lingerScript(), 'Enabling lingering');
            if (parseKeyValues(r.stdout).linger === 'needs-sudo') {
                manualLinger = lingerCommand(host.user);
                progress(
                    `Lingering needs sudo, so the agent stops when you log out of the VM. Run this in the setup terminal: ${manualLinger}`,
                );
            }
        });

        await this.step(progress, 'Restarting the agent', () =>
            // Always a restart after a full install: an agent still running from a
            // broken or half-removed install would otherwise go on serving.
            this.run(host, startServiceScript({restart: true}), 'Starting the agent'),
        );
        return manualLinger ? {lingerCommand: manualLinger} : {};
    }

    /** Report `name`, run it, and turn any failure into one naming the step. */
    private async step<T>(progress: (line: string) => void, name: string, body: () => Promise<T>): Promise<T> {
        progress(`${name}…`);
        try {
            return await body();
        } catch (err) {
            if (err instanceof StepFailure) throw err;
            const message = err instanceof Error ? err.message : String(err);
            throw new StepFailure(`${name} failed: ${message}`);
        }
    }

    /** Run a script and require exit 0; otherwise fail with what the host printed. */
    private async run(
        host: RemoteConfig,
        script: string,
        name: string,
        options: {stdin?: string; timeoutMs?: number} = {},
    ): Promise<RemoteRun> {
        const r = await this.deps.provisioner.run(host, script, {timeoutMs: STEP_TIMEOUT_MS, ...options});
        if (r.code !== 0) throw new StepFailure(`${name} failed (exit ${r.code}): ${hostMessage(r)}`);
        return r;
    }

    private mark(projectPath: string, progress: (line: string) => void): void {
        const at = new Date(this.deps.clock.now()).toISOString();
        this.deps.settings.markAgentInstalled(projectPath, this.deps.appVersion, at);
        progress(`The agent ${this.deps.appVersion} is running.`);
    }
}

/** The line a progress log shows for a host that passed the check. */
function describeHost(check: HostCheck): string {
    return [
        `Linux ${check.arch}`,
        check.glibcVersion ? `glibc ${check.glibcVersion}` : null,
        check.sudo ? 'sudo available' : 'no password-less sudo',
        check.agentVersion ? `agent ${check.agentVersion} installed` : 'no agent yet',
    ]
        .filter(Boolean)
        .join(', ');
}

/** What a failed script said: its stderr's last lines, or its stdout's when stderr is empty. */
function hostMessage(r: RemoteRun): string {
    const text = (r.stderr.trim() || r.stdout.trim() || 'no output').split('\n');
    return text.slice(-3).join(' / ');
}
