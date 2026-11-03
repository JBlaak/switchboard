/**
 * Builds the agent's three parts from real Node adapters (#276, stage 1).
 *
 * The agent runs as a systemd user service, whose environment is not the VM
 * user's: its PATH is systemd's short default, without `~/.local/bin` where
 * Claude's installer puts `claude`. So the login shell is asked for its
 * environment once, at start, and everything that runs a tool (the PTYs, git,
 * the tool checks) inherits that.
 *
 * The hook server is started, and awaited, before the parts are handed back:
 * a launch asks it for its address, and one made before it listens would get
 * no question hook.
 */
import os from 'node:os';

import {uuidGenerator} from '../application/ports/ids';
import {HookForwarder} from '../application/services/agent-host/hook-forwarder';
import {HostConfig} from '../application/services/agent-host/host-config';
import {SessionHost} from '../application/services/agent-host/session-host';
import {NodeClaudeConfigDir} from '../infrastructure/agent/node-claude-config-dir';
import {NodeCommandRunner} from '../infrastructure/agent/node-command-runner';
import {NodeHostSettingsFile} from '../infrastructure/agent/node-host-settings-file';
import {GitCliWorkspace} from '../infrastructure/git/git-cli-workspace';
import {QuestionHookServer} from '../infrastructure/http/question-hook-server';
import {cleanChildEnv, NodePtyGateway} from '../infrastructure/pty/node-pty-gateway';
import {loginShellEnv} from '../infrastructure/shell/login-shell-env';
import {systemTimers} from '../infrastructure/system/timers';
import type {Logger} from '../application/ports/logger';
import type {AgentParts} from '../application/services/agent-host/agent-host';
import type {CopiesPart} from '../application/services/agent-host/handlers';

/** What the entry hands the wiring. */
export interface PartsContext {
    agentVersion: string;
    log: Logger;
}

/** The VM user's login shell: their passwd entry, else $SHELL, else sh. */
export function vmLoginShell(): string {
    try {
        const fromPasswd = os.userInfo().shell;
        if (fromPasswd) return fromPasswd;
    } catch {
        // No passwd entry (a container with an arbitrary uid): fall through.
    }
    return process.env.SHELL || '/bin/sh';
}

/** The agent's parts, ready to serve; the hook server is listening when this resolves. */
export async function createParts({log}: PartsContext): Promise<AgentParts> {
    const loginShell = vmLoginShell();
    const env = await loginShellEnv(() => loginShell, cleanChildEnv(), log)();
    log.info(`[agent] login shell ${loginShell}, PATH=${env.PATH}`);

    let hookServer: QuestionHookServer | null = null;
    const hooks = new HookForwarder({
        endpoint: {
            get url() {
                return hookServer?.url ?? null;
            },
            get token() {
                return hookServer?.token ?? '';
            },
        },
        timers: systemTimers,
        ids: uuidGenerator,
        log,
    });
    hookServer = new QuestionHookServer({receiver: hooks.receiver, archiveTool: hooks.archiveTool, log});
    await hookServer.start();

    const config = new HostConfig({
        settingsFile: new NodeHostSettingsFile(),
        commands: new NodeCommandRunner({env}),
        claudeDir: new NodeClaudeConfigDir(),
        log,
    });

    const sessions = new SessionHost({
        terminals: new NodePtyGateway({env}),
        loginShell,
        hooks,
        hostSettings: () => config.current(),
        git: new GitCliWorkspace(async () => env),
        home: os.homedir(),
        timers: systemTimers,
        log,
    });

    // The hook server needs no stop of its own: it lives as long as the
    // process, which exits right after the sessions are terminated.
    return {sessions, hooks, config, copies: notYetCopies(log)};
}

/** Until the copies part lands (#276 stage 2): every request answers that copies are not supported yet. */
function notYetCopies(log: Logger): CopiesPart {
    return {
        clientConnected() {},
        clientGone() {},
        handle(client, message) {
            if (!('requestId' in message)) return;
            log.warn(`[agent] ${message.type}: project copies are not supported by this agent yet`);
            const error = 'project copies are not supported by this agent yet';
            if (message.type === 'handoff')
                client.send({type: 'handoff-done', requestId: message.requestId, ok: false, error});
            else if (message.type === 'copy-status')
                client.send({type: 'copy-state', requestId: message.requestId, ok: false, error});
            else client.send({type: 'done', requestId: message.requestId, ok: false, error});
        },
    };
}
