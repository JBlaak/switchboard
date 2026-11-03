/**
 * VM hosts as the renderer shows them (#276): which projects are VM projects,
 * and, per project page that asked, the agent's status, an install's progress,
 * the setup checks and the host settings.
 *
 * A VM project is a remote whose host has a Switchboard agent. Which ones are
 * comes with the project list (`Project.agent`), and an install that finishes
 * here makes its project one at once, before the list is read again.
 *
 * Everything per host is keyed by the project path the page asked with, since
 * main names a host by any project path on it. A host that can't be reached
 * answers null, which is kept as `unreachable` rather than an empty form.
 *
 * The events are declared here rather than in `events.ts`, like the phone
 * access ones; `events.ts` folds them into the union. The install's progress
 * is main's push and lives there.
 */
import {withEntry} from './records';
import type {AgentHostStatus} from '../../ipc/api';
import type {HostSettings, ToolCheck} from '../../domain/agent/protocol';
import type {IdRecord} from './records';
import type {RendererEvent} from './events';

export type AgentHostEvent =
    /** The project list was read: these are its VM projects, and no others. */
    | {type: 'agentProjectsLoaded'; projectPaths: readonly string[]}
    | {type: 'agentStatusLoaded'; projectPath: string; status: AgentHostStatus}
    /** Install agent, Retry or Update agent was pressed. */
    | {type: 'agentInstallStarted'; projectPath: string}
    | {type: 'agentInstallFinished'; projectPath: string; ok: boolean; error?: string}
    | {type: 'agentToolsRequested'; projectPath: string}
    /** Null: the host couldn't be reached. */
    | {type: 'agentToolsLoaded'; projectPath: string; answer: {tools: ToolCheck[]; sudo: boolean} | null}
    | {type: 'agentHostSettingsRequested'; projectPath: string}
    /** The settings read or saved; null when the host couldn't be reached to read them. */
    | {type: 'agentHostSettingsLoaded'; projectPath: string; settings: HostSettings | null}
    /** A change didn't land; the form keeps what the host last said. */
    | {type: 'agentHostSettingsSaveFailed'; projectPath: string; message: string}
    /** Open setup terminal was pressed; why it failed before is cleared. */
    | {type: 'agentSetupTerminalOpening'; projectPath: string}
    | {type: 'agentSetupTerminalFailed'; projectPath: string; message: string};

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
    /** Null until main has answered. */
    readonly status: AgentHostStatus | null;
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
    readonly hosts: IdRecord<AgentHostView>;
}

export const NO_HOST: AgentHostView = {
    status: null,
    install: {phase: 'idle'},
    tools: null,
    settings: null,
    setupError: null,
};

export const initialAgentHostState: AgentHostState = {vmProjects: {}, hosts: {}};

/** How many progress lines are kept; an install prints a few dozen. */
const MAX_LINES = 200;

export function agentHostReducer(state: AgentHostState, event: RendererEvent): AgentHostState {
    switch (event.type) {
        case 'agentProjectsLoaded': {
            const next: Record<string, true> = {};
            for (const path of event.projectPaths) next[path] = true;
            // An install that just finished here stays a VM project until the list catches up.
            for (const [path, host] of Object.entries(state.hosts)) {
                if (host.install.phase === 'done') next[path] = true;
            }
            return sameKeys(state.vmProjects, next) ? state : {...state, vmProjects: next};
        }

        case 'agentStatusLoaded':
            return withHost(state, event.projectPath, (host) => ({...host, status: event.status}));

        case 'agentInstallStarted':
            return withHost(state, event.projectPath, (host) =>
                host.install.phase === 'running' ? host : {...host, install: {phase: 'running', lines: []}},
            );

        case 'agentInstallProgress':
            return withHost(state, event.projectPath, (host) =>
                host.install.phase === 'running'
                    ? {
                          ...host,
                          install: {phase: 'running', lines: [...host.install.lines, event.line].slice(-MAX_LINES)},
                      }
                    : host,
            );

        case 'agentInstallFinished': {
            const host = state.hosts[event.projectPath] ?? NO_HOST;
            const lines = host.install.phase === 'idle' ? [] : host.install.lines;
            if (!event.ok) {
                const error = event.error || 'The agent couldn’t be installed';
                return withHost(state, event.projectPath, (h) => ({...h, install: {phase: 'failed', lines, error}}));
            }
            const next = withHost(state, event.projectPath, (h) => ({...h, install: {phase: 'done', lines}}));
            return {...next, vmProjects: withEntry(next.vmProjects, event.projectPath, true)};
        }

        case 'agentToolsRequested':
            // A refresh keeps the checks it has on screen until the answer lands.
            return withHost(state, event.projectPath, (host) =>
                host.tools?.phase === 'ok' ? host : {...host, tools: {phase: 'loading'}},
            );

        case 'agentToolsLoaded':
            return withHost(state, event.projectPath, (host) => ({
                ...host,
                tools: event.answer
                    ? {phase: 'ok', tools: event.answer.tools, sudo: event.answer.sudo}
                    : {phase: 'unreachable'},
            }));

        case 'agentHostSettingsRequested':
            return withHost(state, event.projectPath, (host) =>
                host.settings?.phase === 'ok' ? host : {...host, settings: {phase: 'loading'}},
            );

        case 'agentHostSettingsLoaded':
            return withHost(state, event.projectPath, (host) => ({
                ...host,
                settings: event.settings
                    ? {phase: 'ok', settings: event.settings, saveError: null}
                    : {phase: 'unreachable'},
            }));

        case 'agentHostSettingsSaveFailed':
            return withHost(state, event.projectPath, (host) =>
                host.settings?.phase === 'ok'
                    ? {...host, settings: {...host.settings, saveError: event.message}}
                    : {...host, settings: {phase: 'unreachable'}},
            );

        case 'agentSetupTerminalOpening':
            return withHost(state, event.projectPath, (host) =>
                host.setupError === null ? host : {...host, setupError: null},
            );

        case 'agentSetupTerminalFailed':
            return withHost(state, event.projectPath, (host) => ({...host, setupError: event.message}));

        default:
            return state;
    }
}

function withHost(
    state: AgentHostState,
    projectPath: string,
    change: (host: AgentHostView) => AgentHostView,
): AgentHostState {
    const host = state.hosts[projectPath] ?? NO_HOST;
    const next = change(host);
    if (next === host) return state;
    return {...state, hosts: withEntry(state.hosts, projectPath, next)};
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

export function hostViewIn(state: AgentHostState, projectPath: string): AgentHostView {
    return state.hosts[projectPath] ?? NO_HOST;
}
