/**
 * VM hosts as the renderer shows them (#276, #307): which projects are VM
 * projects, and, per registered VM, an install's progress, the setup checks
 * and the host settings that Settings → VMs shows.
 *
 * A VM project is a remote whose host has a Switchboard agent. Which ones are
 * comes with the project list (`Project.agent`), which main works out from
 * the VM registry.
 *
 * Everything per host is keyed by the VM's key, `user@host:port`
 * (`vmHostKey`), since the controls belong to the VM rather than to one of
 * its projects. A host that can't be reached answers null, which is kept as
 * `unreachable` rather than an empty form.
 *
 * The events are declared here rather than in `events.ts`, like the phone
 * access ones; `events.ts` folds them into the union. The install's progress
 * is main's push and lives there.
 */
import {withEntry} from './records';
import type {HostSettings, ToolCheck} from '../../domain/agent/protocol';
import type {IdRecord} from './records';
import type {RendererEvent} from './events';

export type AgentHostEvent =
    /** The project list was read: these are its VM projects, and no others. */
    /** `copyPaths`: those of them that are hand-off copies of a local project, which a session can be brought back from. */
    | {type: 'agentProjectsLoaded'; projectPaths: readonly string[]; copyPaths?: readonly string[]}
    /** Install agent, Retry or Update agent was pressed. */
    | {type: 'agentInstallStarted'; hostKey: string}
    | {type: 'agentInstallFinished'; hostKey: string; ok: boolean; error?: string}
    | {type: 'agentToolsRequested'; hostKey: string}
    /** Null: the host couldn't be reached. */
    | {type: 'agentToolsLoaded'; hostKey: string; answer: {tools: ToolCheck[]; sudo: boolean} | null}
    | {type: 'agentHostSettingsRequested'; hostKey: string}
    /** The settings read or saved; null when the host couldn't be reached to read them. */
    | {type: 'agentHostSettingsLoaded'; hostKey: string; settings: HostSettings | null}
    /** A change didn't land; the form keeps what the host last said. */
    | {type: 'agentHostSettingsSaveFailed'; hostKey: string; message: string}
    /** Open setup terminal was pressed; why it failed before is cleared. */
    | {type: 'agentSetupTerminalOpening'; hostKey: string}
    | {type: 'agentSetupTerminalFailed'; hostKey: string; message: string};

export type InstallState =
    | {readonly phase: 'idle'}
    | {readonly phase: 'running'; readonly lines: readonly string[]}
    | {readonly phase: 'failed'; readonly lines: readonly string[]; readonly error: string}
    | {readonly phase: 'done'; readonly lines: readonly string[]};

export type ToolsState =
    | {readonly phase: 'loading'}
    | {readonly phase: 'ok'; readonly tools: readonly ToolCheck[]; readonly sudo: boolean}
    | {readonly phase: 'unreachable'};

export type HostSettingsState =
    | {readonly phase: 'loading'}
    | {readonly phase: 'ok'; readonly settings: HostSettings; readonly saveError: string | null}
    | {readonly phase: 'unreachable'};

export interface AgentHostView {
    readonly install: InstallState;
    /** Null until they are asked for. */
    readonly tools: ToolsState | null;
    readonly settings: HostSettingsState | null;
    /** Why Open setup terminal didn't open one. */
    readonly setupError: string | null;
}

export interface AgentHostState {
    /** projectPath → true, for every VM project. */
    readonly vmProjects: IdRecord<true>;
    /** projectPath → true, for every VM project that is a hand-off copy of a local one. */
    readonly vmCopies: IdRecord<true>;
    /** VM key → its controls' state. */
    readonly hosts: IdRecord<AgentHostView>;
}

export const NO_HOST: AgentHostView = {
    install: {phase: 'idle'},
    tools: null,
    settings: null,
    setupError: null,
};

export const initialAgentHostState: AgentHostState = {vmProjects: {}, vmCopies: {}, hosts: {}};

/** How many progress lines are kept; an install prints a few dozen. */
const MAX_LINES = 200;

export function agentHostReducer(state: AgentHostState, event: RendererEvent): AgentHostState {
    switch (event.type) {
        case 'agentProjectsLoaded': {
            const next: Record<string, true> = {};
            for (const path of event.projectPaths) next[path] = true;
            const copies: Record<string, true> = {};
            for (const path of event.copyPaths ?? []) copies[path] = true;
            if (sameKeys(state.vmProjects, next) && sameKeys(state.vmCopies, copies)) return state;
            return {...state, vmProjects: next, vmCopies: copies};
        }

        case 'agentInstallStarted':
            return withHost(state, event.hostKey, (host) =>
                host.install.phase === 'running' ? host : {...host, install: {phase: 'running', lines: []}},
            );

        case 'agentInstallProgress':
            return withHost(state, event.hostKey, (host) =>
                host.install.phase === 'running'
                    ? {
                          ...host,
                          install: {phase: 'running', lines: [...host.install.lines, event.line].slice(-MAX_LINES)},
                      }
                    : host,
            );

        case 'agentInstallFinished': {
            const host = state.hosts[event.hostKey] ?? NO_HOST;
            const lines = host.install.phase === 'idle' ? [] : host.install.lines;
            if (!event.ok) {
                const error = event.error || 'The agent couldn’t be installed';
                return withHost(state, event.hostKey, (h) => ({...h, install: {phase: 'failed', lines, error}}));
            }
            return withHost(state, event.hostKey, (h) => ({...h, install: {phase: 'done', lines}}));
        }

        case 'agentToolsRequested':
            // A refresh keeps the checks it has on screen until the answer lands.
            return withHost(state, event.hostKey, (host) =>
                host.tools?.phase === 'ok' ? host : {...host, tools: {phase: 'loading'}},
            );

        case 'agentToolsLoaded':
            return withHost(state, event.hostKey, (host) => ({
                ...host,
                tools: event.answer
                    ? {phase: 'ok', tools: event.answer.tools, sudo: event.answer.sudo}
                    : {phase: 'unreachable'},
            }));

        case 'agentHostSettingsRequested':
            return withHost(state, event.hostKey, (host) =>
                host.settings?.phase === 'ok' ? host : {...host, settings: {phase: 'loading'}},
            );

        case 'agentHostSettingsLoaded':
            return withHost(state, event.hostKey, (host) => ({
                ...host,
                settings: event.settings
                    ? {phase: 'ok', settings: event.settings, saveError: null}
                    : {phase: 'unreachable'},
            }));

        case 'agentHostSettingsSaveFailed':
            return withHost(state, event.hostKey, (host) =>
                host.settings?.phase === 'ok'
                    ? {...host, settings: {...host.settings, saveError: event.message}}
                    : {...host, settings: {phase: 'unreachable'}},
            );

        case 'agentSetupTerminalOpening':
            return withHost(state, event.hostKey, (host) =>
                host.setupError === null ? host : {...host, setupError: null},
            );

        case 'agentSetupTerminalFailed':
            return withHost(state, event.hostKey, (host) => ({...host, setupError: event.message}));

        default:
            return state;
    }
}

function withHost(
    state: AgentHostState,
    hostKey: string,
    change: (host: AgentHostView) => AgentHostView,
): AgentHostState {
    const host = state.hosts[hostKey] ?? NO_HOST;
    const next = change(host);
    if (next === host) return state;
    return {...state, hosts: withEntry(state.hosts, hostKey, next)};
}

function sameKeys(a: IdRecord<true>, b: IdRecord<true>): boolean {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => b[key]);
}

// ── What the surfaces read ──

/** Whether a project is a VM project: a remote whose host runs a Switchboard agent. */
export function isVmProjectIn(state: AgentHostState, projectPath: string | null | undefined): boolean {
    return !!projectPath && state.vmProjects[projectPath] === true;
}

/** Whether a project is a VM copy of a local project (#276), which its sessions can be brought back to. */
export function isVmCopyIn(state: AgentHostState, projectPath: string | null | undefined): boolean {
    return !!projectPath && state.vmCopies[projectPath] === true;
}

/** A VM's controls' state, by its key. */
export function hostViewIn(state: AgentHostState, hostKey: string): AgentHostView {
    return state.hosts[hostKey] ?? NO_HOST;
}
