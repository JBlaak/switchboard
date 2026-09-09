/**
 * Opening a session.
 *
 * One entry point, four outcomes: reattach to a session already running, dial a
 * remote host, start a plain shell, or start a Claude session. They share the
 * shell resolution and the bookkeeping that makes fork detection possible, and
 * differ in what they actually spawn — which is why they are branches of one
 * method rather than four use cases with three-quarters of their bodies in
 * common.
 */
import { buildClaudeCommand, PLAIN_TERMINAL_CLAUDE_SHIM } from '../../domain/launch/claude-command';
import { claudeSessionEnv, plainTerminalEnv } from '../../domain/launch/terminal-env';
import { isWslShell, windowsToWslPath } from '../../domain/shell/shell-profile';
import { shellArgs } from '../../domain/shell/quoting';
import {
  isRemoteProjectPath, parseRemoteProjectPath, remoteTargetLabel,
} from '../../domain/project/remote-target';
import { encodeProjectPath } from '../../domain/project/project-path';
import { ActiveSession } from '../model/active-session';
import type { RemoteConnectionState } from '../model/active-session';
import type { SessionOptions } from '../../domain/launch/session-options';
import type { ShellProfile } from '../../domain/shell/shell-profile';
import type { SessionRegistry } from '../model/session-registry';
import type { Clock, Timers } from '../ports/clock';
import type { IdeBridgeHandle } from '../ports/ide-bridge';
import type { IdeBridge } from '../ports/ide-bridge';
import type { Logger } from '../ports/logger';
import type { PtyHandle, TerminalGateway } from '../ports/terminal-gateway';
import type { ShellProfileProvider } from '../ports/shell-profiles';
import type { TranscriptStore } from '../ports/transcript-store';
import type { RendererGateway } from '../ports/renderer-gateway';
import type { RemoteConnectionSupervisor } from './remote-connection-supervisor';
import type { SessionLifecycle } from './session-lifecycle';
import type { SettingsService } from './settings-service';

/** The spawn geometry before the renderer reports its real terminal size. */
const SPAWN_COLS = 120;
const SPAWN_ROWS = 30;

/**
 * How long to wait before writing the `claude` shim into a plain terminal.
 *
 * zsh ignores ENV/BASH_ENV, so the function has to be typed into the shell
 * once it is accepting input.
 */
const SHIM_WRITE_DELAY_MS = 300;

export interface OpenSessionRequest {
  sessionId: string;
  projectPath: string;
  isNew: boolean;
  options?: SessionOptions;
}

export interface OpenSessionResult {
  ok: boolean;
  error?: string;
  reattached?: boolean;
  /** True when the CLI will find an IDE to talk to. */
  mcpActive?: boolean;
}

export interface SessionLauncherDeps {
  registry: SessionRegistry;
  terminals: TerminalGateway;
  shells: ShellProfileProvider;
  transcripts: TranscriptStore;
  settings: SettingsService;
  ideBridge: IdeBridge;
  lifecycle: SessionLifecycle;
  remote: RemoteConnectionSupervisor;
  renderer: RendererGateway;
  clock: Clock;
  timers: Timers;
  log: Logger;
  homeDir: string;
  fileExists(path: string): boolean;
}

/** The resolved shell for a launch, plus what WSL needs on top. */
interface ResolvedShell {
  profile: ShellProfile;
  path: string;
  extraArgs: string[];
  isWsl: boolean;
  /** WSL spawns from a Windows path but starts the session elsewhere. */
  cwd: string;
}

export class SessionLauncher {
  constructor(private readonly deps: SessionLauncherDeps) {}

  async open(request: OpenSessionRequest): Promise<OpenSessionResult> {
    const existing = this.deps.registry.get(request.sessionId);
    if (existing) return this.#reattach(request.sessionId, existing);
    return this.#spawn(request);
  }

  /**
   * Hand a running session back to a renderer that wants it on screen.
   *
   * Everything the renderer lost — the alternate screen, the scrollback, where
   * a remote connection stands — is replayed rather than re-derived.
   */
  #reattach(sessionId: string, session: ActiveSession): OpenSessionResult {
    session.rendererAttached = true;
    session.firstResize = !session.isPlainTerminal;

    // A remote session waiting out its reconnect backoff is still "here": its
    // buffer replays like any other reattach. Clicking it is an explicit ask
    // for the connection back, so it skips the rest of the wait — done after
    // the replay so the new status line lands on top of the old screen.
    const redial = session.wantsRedial;
    if (session.remote && !redial) this.deps.remote.resendStatus(sessionId, session);

    this.deps.lifecycle.replayTo(sessionId, session);

    if (redial) this.deps.remote.redialNow(sessionId);

    return { ok: true, reattached: true, mcpActive: !!session.ideBridge };
  }

  async #spawn(request: OpenSessionRequest): Promise<OpenSessionResult> {
    const { projectPath, sessionId, isNew, options } = request;
    const { registry, lifecycle, remote, log } = this.deps;

    const isRemote = isRemoteProjectPath(projectPath);
    if (!isRemote && !this.deps.fileExists(projectPath)) {
      return { ok: false, error: `project directory no longer exists: ${projectPath}` };
    }

    const isPlainTerminal = !isRemote && options?.type === 'terminal';
    const shell = this.#resolveShell(projectPath, isPlainTerminal);
    log.info(`[shell] profile=${shell.profile.id} shell=${shell.path} args=${JSON.stringify(shell.extraArgs)}`);

    const bookkeeping = (!isPlainTerminal && !isRemote)
      ? this.#snapshotTranscripts(projectPath, sessionId, isNew)
      : { projectFolder: null, knownTranscriptIds: null, sessionSlug: null };

    let pty: PtyHandle;
    let ideBridge: IdeBridgeHandle | null = null;
    let remoteState: RemoteConnectionState | null = null;

    try {
      if (isRemote) {
        const started = this.#startRemote(sessionId, projectPath, shell, options);
        if ('error' in started) return { ok: false, error: started.error };
        remoteState = started.state;
        pty = started.pty;
      } else if (isPlainTerminal) {
        pty = this.#startPlainTerminal(shell);
      } else {
        const started = await this.#startClaude(sessionId, projectPath, isNew, shell, options);
        if ('error' in started) return { ok: false, error: started.error };
        ideBridge = started.ideBridge;
        pty = started.pty;
      }
    } catch (err) {
      return { ok: false, error: `Error spawning PTY: ${(err as Error).message}` };
    }

    const session = new ActiveSession({
      pty,
      projectPath,
      projectFolder: bookkeeping.projectFolder,
      knownTranscriptIds: bookkeeping.knownTranscriptIds,
      sessionSlug: bookkeeping.sessionSlug,
      isPlainTerminal,
      forkFrom: options?.forkFrom || null,
      ideBridge,
      remote: remoteState,
      openedAt: this.deps.clock.now(),
    });

    registry.add(sessionId, session);
    lifecycle.wire(sessionId, session);

    // Tell the renderer a connection is in flight. Until ssh prints something
    // there is nothing on screen at all, and a slow or unreachable host is
    // otherwise indistinguishable from the app doing nothing.
    if (remoteState) {
      remote.sendStatus(sessionId, { phase: 'connecting', target: remoteState.target });
    }

    if (options?.forkFrom) {
      log.info(`[fork-spawn] tempId=${sessionId} forkFrom=${options.forkFrom} folder=${bookkeeping.projectFolder} knownFiles=${bookkeeping.knownTranscriptIds?.size ?? 0}`);
    }

    return { ok: true, reattached: false, mcpActive: !!ideBridge };
  }

  /**
   * Which shell to launch in.
   *
   * WSL profiles only work for plain terminals — a Claude session needs the
   * Windows shell, because the session data lives on the Windows filesystem —
   * so a WSL profile silently falls back to auto-detection for one.
   */
  #resolveShell(projectPath: string, isPlainTerminal: boolean): ResolvedShell {
    const { shells, settings, homeDir } = this.deps;
    const requested = shells.resolve(settings.shellProfileId(projectPath));
    const profile = (isWslShell(requested.path) && !isPlainTerminal)
      ? shells.resolve('auto')
      : requested;

    const extraArgs = [...(profile.args || [])];
    const isWsl = isWslShell(profile.path);
    if (isWsl) {
      // The distribution sees a /mnt/ path, but wsl.exe itself must be spawned
      // from a valid Windows directory.
      extraArgs.unshift('--cd', windowsToWslPath(projectPath));
    }

    return {
      profile,
      path: profile.path,
      extraArgs,
      isWsl,
      cwd: isWsl ? homeDir : projectPath,
    };
  }

  /**
   * Note which transcripts existed before the spawn, and this session's slug.
   *
   * Both are what makes a later fork or plan-accept recognisable: a transcript
   * appearing that was not in the snapshot is the signal, and the slug is what
   * ties a plan handover to the session it came from.
   */
  #snapshotTranscripts(projectPath: string, sessionId: string, isNew: boolean): {
    projectFolder: string;
    knownTranscriptIds: Set<string>;
    sessionSlug: string | null;
  } {
    const { transcripts } = this.deps;
    // The folder name is derived, not created: a project with no history yet
    // has no directory, and Claude CLI is the one that makes it.
    const projectFolder = encodeProjectPath(projectPath);
    return {
      projectFolder,
      knownTranscriptIds: new Set(transcripts.listSessionIds(projectFolder)),
      sessionSlug: isNew ? null : transcripts.readSlug(projectFolder, sessionId),
    };
  }

  /**
   * Connect to a remote project.
   *
   * The "session" is a tmux session on the remote host and the PTY runs ssh
   * attached to it. No local transcripts, no IDE bridge, no shell profile — and
   * no auto-connect: this only runs when the user clicks, because auth may need
   * interaction (host key prompts, 1Password approval, passwords) that renders
   * in the terminal.
   */
  #startRemote(
    sessionId: string,
    projectPath: string,
    shell: ResolvedShell,
    options?: SessionOptions,
  ): { state: RemoteConnectionState; pty: PtyHandle } | { error: string } {
    const { settings, renderer, remote, clock } = this.deps;

    const config = parseRemoteProjectPath(projectPath);
    if (!config) return { error: `invalid remote project: ${projectPath}` };

    const kind = options?.remoteKind === 'shell' ? 'shell' : 'claude';
    const record = settings.touchRemoteSession(projectPath, sessionId, kind, new Date(clock.now()).toISOString());
    if (!record) return { error: `remote project no longer exists: ${projectPath}` };
    renderer.projectsChanged();

    // Everything a reconnect needs, so re-dialling never has to go back to
    // settings or re-resolve the shell profile.
    const state: RemoteConnectionState = {
      remote: config,
      kind: record.kind,
      shell: shell.path,
      shellExtraArgs: shell.extraArgs,
      target: remoteTargetLabel(config),
      attempt: 0,
      timer: null,
      sawData: false,
      tail: '',
      userDisconnected: false,
      fatal: false,
      everConnected: false,
      spawnedAt: clock.now(),
    };

    return { state, pty: remote.spawn(sessionId, state) };
  }

  /** Start an interactive login shell, with no `claude` in it. */
  #startPlainTerminal(shell: ResolvedShell): PtyHandle {
    const { terminals, timers } = this.deps;
    const pty = terminals.spawn({
      file: shell.path,
      args: shellArgs(shell.path, undefined, shell.extraArgs),
      cwd: shell.cwd,
      cols: SPAWN_COLS,
      rows: SPAWN_ROWS,
      env: plainTerminalEnv(terminals.baseEnv),
    });

    // zsh reads neither ENV nor BASH_ENV, so the shim is typed in once the
    // shell is up. Guarded because a shell that died on startup is not worth
    // writing to.
    timers.setTimeout(() => {
      if (pty.disposed) return;
      try {
        pty.write(PLAIN_TERMINAL_CLAUDE_SHIM + ' clear\n');
      } catch {
        // The shell exited between the check and the write.
      }
    }, SHIM_WRITE_DELAY_MS);

    return pty;
  }

  /**
   * Start a Claude session, with an IDE bridge if the user wants one.
   *
   * A bridge that fails to start is logged and skipped: the session still runs,
   * just with Claude's edits going to the user's own editor instead of the side
   * panel.
   */
  async #startClaude(
    sessionId: string,
    projectPath: string,
    isNew: boolean,
    shell: ResolvedShell,
    options?: SessionOptions,
  ): Promise<{ ideBridge: IdeBridgeHandle | null; pty: PtyHandle } | { error: string }> {
    const { terminals, ideBridge: bridge, log } = this.deps;

    let ideBridge: IdeBridgeHandle | null = null;
    if (options?.mcpEmulation !== false) {
      try {
        ideBridge = await bridge.start(sessionId, [projectPath]);
      } catch (err) {
        log.error(`[mcp] failed to start the IDE bridge for ${sessionId}: ${(err as Error).message}`);
      }
    }

    let command: string;
    try {
      command = buildClaudeCommand({
        shellPath: shell.path,
        target: { sessionId, isNew },
        options,
        ideBridge: !!ideBridge,
      });
    } catch (err) {
      if (ideBridge) bridge.stop(sessionId);
      return { error: (err as Error).message };
    }

    const pty = terminals.spawn({
      file: shell.path,
      args: shellArgs(shell.path, command, shell.extraArgs),
      cwd: shell.cwd,
      cols: SPAWN_COLS,
      rows: SPAWN_ROWS,
      env: claudeSessionEnv(terminals.baseEnv, { ideBridgePort: ideBridge?.port }),
    });

    return { ideBridge, pty };
  }
}
