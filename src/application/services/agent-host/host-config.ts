/**
 * The agent's host settings, its setup tool checks and the global config
 * copy's writer (#276, #278).
 *
 * The settings are true of the machine whichever client connects (the host
 * instructions, the config copy switch, the base folder), so they live on the
 * agent, as JSON at HOST_SETTINGS_FILE. A file that is missing, unreadable or
 * not what we wrote gives the defaults rather than an error: a broken settings
 * file must never stop the agent from running sessions.
 *
 * The tool checks are what the setup terminal's green checks show. Each one
 * runs a command with a timeout, because a CLI waiting on a TTY or the network
 * would otherwise hang the reply, and every check runs at once.
 *
 * The config copy writes what the Mac sends under `~/.claude`, one way only.
 * Every path is checked again with `isSafeConfigPath` here, whatever the Mac
 * already checked: the agent is the last line before the VM's disk, and a path
 * like `../.ssh/authorized_keys` or `.credentials.json` must never be written.
 *
 * The three dependencies are small ports declared below, with Node adapters in
 * `src/infrastructure/agent/`.
 */
import {DEFAULT_BASE_FOLDER, defaultHostInstructions} from '../../../domain/agent/host-instructions';
import {isSafeConfigPath} from '../../../domain/agent/protocol';
import type {
    AgentTool,
    CopyConfigMessage,
    HostSettings,
    SetHostSettingsMessage,
    ToolCheck,
} from '../../../domain/agent/protocol';
import type {ClientLink} from '../../ports/agent-link';
import type {Logger} from '../../ports/logger';
import type {HostConfigMessage, HostConfigPart} from './handlers';

// ── Ports ──

/** The host settings file, as raw text. */
export interface HostSettingsFile {
    /** The file's text, or null when it does not exist or cannot be read. */
    read(): string | null;
    /** Replace the file's text, atomically; may throw. */
    write(text: string): void;
}

/** What one command did. */
export interface CommandResult {
    /** Null when the command could not be started (not installed) or was killed on its timeout. */
    exitCode: number | null;
    stdout: string;
    stderr: string;
}

/** Runs a command without a shell, never waiting longer than `timeoutMs`. */
export interface CommandRunner {
    /** Never rejects: a missing binary or a timeout is an `exitCode` of null. */
    run(command: string, args: string[], options: {timeoutMs: number}): Promise<CommandResult>;
}

/**
 * The VM user's `~/.claude`, with every path relative to it. The adapter
 * refuses a path that resolves outside it, as a second check after
 * `isSafeConfigPath`.
 */
export interface ClaudeConfigDir {
    exists(relativePath: string): boolean;
    /** Create the folders, write `<file>.tmp`, then rename over the file; may throw. */
    write(relativePath: string, content: Uint8Array, mode: number): void;
    /** Remove a file; a missing one is fine; may throw. */
    remove(relativePath: string): void;
}

// ── The part ──

/** How long one tool check may take before it counts as not installed. */
export const TOOL_CHECK_TIMEOUT_MS = 10_000;

/**
 * Where Claude Code keeps its login on Linux, relative to `~/.claude`. On macOS
 * the CLI uses the Keychain, but on Linux it writes its OAuth credentials to
 * this file (mode 0600); the file existing is the cheapest honest "signed in"
 * we have without starting the CLI. It is also on NEVER_COPIED, so the config
 * copy can never put the Mac's credentials there.
 */
export const CLAUDE_CREDENTIALS_FILE = '.credentials.json';

/** Only these bits of a copied file's mode are kept: never setuid, setgid or sticky. */
const MODE_MASK = 0o777;

export interface HostConfigDeps {
    settingsFile: HostSettingsFile;
    commands: CommandRunner;
    claudeDir: ClaudeConfigDir;
    log: Logger;
    /** Overrides TOOL_CHECK_TIMEOUT_MS, for tests. */
    toolTimeoutMs?: number;
}

export class HostConfig implements HostConfigPart {
    private settings: HostSettings | null = null;

    constructor(private readonly deps: HostConfigDeps) {}

    /** Nothing is per client: every client sees and changes the same settings. */
    public clientConnected(_client: ClientLink): void {}

    public clientGone(_client: ClientLink): void {}

    /** The settings now: read once from the file, then kept as they are changed. */
    public current(): HostSettings {
        this.settings ??= parseHostSettings(this.deps.settingsFile.read());
        return {...this.settings};
    }

    public handle(client: ClientLink, message: HostConfigMessage): void {
        switch (message.type) {
            case 'get-host-settings':
                client.send({type: 'host-settings', requestId: message.requestId, settings: this.current()});
                return;
            case 'set-host-settings':
                client.send({type: 'host-settings', requestId: message.requestId, settings: this.update(message)});
                return;
            case 'check-tools':
                void this.checkTools().then(({tools, sudo}) => {
                    if (!client.closed) client.send({type: 'tools', requestId: message.requestId, tools, sudo});
                });
                return;
            case 'copy-config':
                client.send({type: 'done', requestId: message.requestId, ...this.copyConfig(message)});
                return;
        }
    }

    /**
     * Merge the known, well-typed fields over the current settings and save.
     * A save that fails still changes the settings for this run, and is
     * logged: the reply holds what launches will now use.
     */
    private update(message: SetHostSettingsMessage): HostSettings {
        const next = {...this.current(), ...knownSettings(message.settings)};
        this.settings = next;
        try {
            this.deps.settingsFile.write(JSON.stringify(next, null, 2) + '\n');
        } catch (err) {
            this.deps.log.error('[host-config] could not save the host settings:', err);
        }
        return {...next};
    }

    private async checkTools(): Promise<{tools: ToolCheck[]; sudo: boolean}> {
        const timeoutMs = this.deps.toolTimeoutMs ?? TOOL_CHECK_TIMEOUT_MS;
        const run = (command: string, args: string[]) => this.deps.commands.run(command, args, {timeoutMs});
        const version = async (tool: AgentTool) => {
            const result = await run(tool, ['--version']);
            return result.exitCode === 0 ? {installed: true, version: parseVersion(result.stdout)} : {installed: false};
        };

        const [claude, gh, git, sudo] = await Promise.all([
            version('claude'),
            version('gh').then(async (found) => {
                if (!found.installed) return {...found, loggedIn: false};
                return {...found, loggedIn: (await run('gh', ['auth', 'status'])).exitCode === 0};
            }),
            version('git'),
            run('sudo', ['-n', 'true']),
        ]);

        return {
            tools: [
                {tool: 'claude', ...claude, loggedIn: this.claudeLoggedIn()},
                {tool: 'gh', ...gh},
                {tool: 'git', ...git},
            ],
            sudo: sudo.exitCode === 0,
        };
    }

    private claudeLoggedIn(): boolean {
        try {
            return this.deps.claudeDir.exists(CLAUDE_CREDENTIALS_FILE);
        } catch {
            return false;
        }
    }

    /**
     * Write every safe file and remove every safe stale path, carrying on past
     * a failure so one bad file does not leave the rest of the config behind.
     * Anything skipped or failed is listed in the error.
     */
    private copyConfig(message: CopyConfigMessage): {ok: boolean; error?: string} {
        const unsafe: string[] = [];
        const failed: string[] = [];

        for (const file of message.files) {
            if (!isSafeConfigPath(file.path)) {
                unsafe.push(file.path);
                continue;
            }
            try {
                this.deps.claudeDir.write(
                    file.path,
                    Buffer.from(file.contentBase64, 'base64'),
                    file.mode & MODE_MASK || 0o644,
                );
            } catch (err) {
                failed.push(`${file.path} (${errorText(err)})`);
            }
        }
        for (const path of message.removed) {
            if (!isSafeConfigPath(path)) {
                unsafe.push(path);
                continue;
            }
            try {
                this.deps.claudeDir.remove(path);
            } catch (err) {
                failed.push(`${path} (${errorText(err)})`);
            }
        }

        const problems = [
            unsafe.length ? `Skipped unsafe paths: ${unsafe.join(', ')}` : '',
            failed.length ? `Could not write: ${failed.join(', ')}` : '',
        ].filter(Boolean);
        if (problems.length) this.deps.log.warn(`[host-config] config copy: ${problems.join('; ')}`);
        return problems.length ? {ok: false, error: problems.join('. ')} : {ok: true};
    }
}

/** The settings a host has before anything was saved. */
export function defaultHostSettings(): HostSettings {
    return {instructions: defaultHostInstructions({sudo: false}), copyConfig: true, baseFolder: DEFAULT_BASE_FOLDER};
}

/**
 * The settings in the file's text: its known, well-typed fields over the
 * defaults. Missing or corrupt text gives the defaults.
 */
export function parseHostSettings(text: string | null): HostSettings {
    if (text === null) return defaultHostSettings();
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return defaultHostSettings();
    }
    return {...defaultHostSettings(), ...knownSettings(parsed)};
}

/** Only the fields HostSettings has, and only with the right type; an empty base folder is no base folder. */
function knownSettings(value: unknown): Partial<HostSettings> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    const record = value as Record<string, unknown>;
    const known: Partial<HostSettings> = {};
    if (typeof record.instructions === 'string') known.instructions = record.instructions;
    if (typeof record.copyConfig === 'boolean') known.copyConfig = record.copyConfig;
    if (typeof record.baseFolder === 'string' && record.baseFolder.trim()) known.baseFolder = record.baseFolder.trim();
    return known;
}

/**
 * The version in a `--version` line: `2.0.14 (Claude Code)`, `gh version
 * 2.40.1 (2023-12-13)`, `git version 2.43.0`. The first dotted number, or the
 * first line as it is when there is none.
 */
export function parseVersion(stdout: string): string | undefined {
    const match = /\d+(?:\.\d+)+/.exec(stdout);
    if (match) return match[0];
    const firstLine = stdout.split('\n')[0]?.trim();
    return firstLine || undefined;
}

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
