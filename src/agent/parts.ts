/**
 * Builds the agent's parts from real Node adapters (#276).
 *
 * The agent runs as a systemd user service, whose environment is not the VM
 * user's: its PATH is systemd's short default, without `~/.local/bin` where
 * Claude's installer puts `claude`. So the login shell is asked for its
 * environment once, at start, and everything that runs a tool (the PTYs, git,
 * the tool checks, the project copies' git and gh) inherits that.
 *
 * The hook server is started, and awaited, before the parts are handed back:
 * a launch asks it for its address, and one made before it listens would get
 * no question hook.
 */
import os from 'node:os';
import path from 'node:path';

import {systemClock} from '../application/ports/clock';
import {uuidGenerator} from '../application/ports/ids';
import {Copies} from '../application/services/agent-host/copies';
import {HookForwarder} from '../application/services/agent-host/hook-forwarder';
import {HostConfig} from '../application/services/agent-host/host-config';
import {SessionHost} from '../application/services/agent-host/session-host';
import {Transcripts} from '../application/services/agent-host/transcripts';
import {NodeClaudeConfigDir} from '../infrastructure/agent/node-claude-config-dir';
import {NodeCommandRunner} from '../infrastructure/agent/node-command-runner';
import {NodeCopiesFiles} from '../infrastructure/agent/node-copies-files';
import {NodeCopyCommandRunner} from '../infrastructure/agent/node-copy-command-runner';
import {NodeFolderWatcher} from '../infrastructure/agent/node-folder-watcher';
import {NodeHostSettingsFile} from '../infrastructure/agent/node-host-settings-file';
import {NodeTranscriptFiles} from '../infrastructure/agent/node-transcript-files';
import {GitCliWorkspace} from '../infrastructure/git/git-cli-workspace';
import {QuestionHookServer} from '../infrastructure/http/question-hook-server';
import {cleanChildEnv, NodePtyGateway} from '../infrastructure/pty/node-pty-gateway';
import {loginShellEnv} from '../infrastructure/shell/login-shell-env';
import {systemTimers} from '../infrastructure/system/timers';
import type {Logger} from '../application/ports/logger';
import type {AgentParts} from '../application/services/agent-host/agent-host';

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

    const copies = new Copies({
        commands: new NodeCopyCommandRunner({env}),
        files: new NodeCopiesFiles(),
        hostSettings: () => config.current(),
        home: os.homedir(),
        clock: systemClock,
        timers: systemTimers,
        ids: uuidGenerator,
        log,
    });

    // The copies part owns the uploads, and an import takes its transcript from them.
    const transcripts = new Transcripts({
        files: new NodeTranscriptFiles(),
        watcher: new NodeFolderWatcher(),
        uploads: copies.uploads,
        home: os.homedir(),
        projectsDir: path.join(os.homedir(), '.claude', 'projects'),
        timers: systemTimers,
        log,
    });

    // The hook server needs no stop of its own: it lives as long as the
    // process, which exits right after the sessions are terminated.
    return {sessions, hooks, config, copies, transcripts};
}
