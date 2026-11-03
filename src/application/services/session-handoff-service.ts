/**
 * The Mac's side of session hand-off (#276 stage 3), behind the
 * `SessionHandoff` façade.
 *
 * A session hand-off moves one conversation to a VM and continues it there in
 * the same sidebar row. In order:
 *
 * 1. **Wait for the turn to end.** A session mid-turn is not cut off (story
 *    65): the hand-off says it is `waiting` and goes when the session comes to
 *    its prompt, heard through the prompter's idle signal. It can be cancelled
 *    while it waits, which changes nothing.
 * 2. **Hand the checkout off**, through the project hand-off: the project's
 *    own checkout, or the worktree the session works in, which the VM
 *    recreates with the same name and branch (story 64).
 * 3. **Carry the transcript**: read whole, every line's `cwd` moved to the
 *    VM's folder (`rewriteTranscriptCwd`), uploaded, and imported where
 *    `claude --resume` on the VM finds it.
 * 4. **Stop the local session** and wait for its process to end, so two
 *    copies of the conversation never drift apart (story 63).
 * 5. **Record** it in `handedOffSessions`, which keeps the local row out of
 *    the list, and touch the VM's remote session record, which gives the row
 *    its new home.
 * 6. **Resume on the VM** under the same id, with the copy's default session
 *    options as a resume from its row would use them, and tell the renderer
 *    the session started there.
 *
 * Failure before step 4 leaves everything on the Mac as it was: the session
 * still runs (or is still ended) here, and nothing is recorded. The copy on
 * the VM may have been made or updated, which is harmless; a transcript the
 * VM already imported makes a second try fail at the import, which says so.
 * Once the local session is stopped the hand-off is committed: a resume that
 * fails on the VM is reported in plain words, the record stays (the
 * transcript is on the VM, and the row's Resume opens it there and tries
 * again), and the Mac's own transcript is still on disk.
 *
 * About `~`: the copy's folder is known only as a project path names it, which
 * may start with `~`, and the Mac does not know the VM's home. The transcript's
 * `cwd` is written in that same form: `claude --resume` finds a transcript by
 * the folder it lives in (which the agent's `import-transcript` expands), not
 * by its `cwd` lines, and the form is the one the VM project's own path uses,
 * so a reader on the Mac matches it as it is. The agent could expand a leading
 * `~` in those lines on import when it wants them absolute.
 *
 * One hand-off per session at a time; the IPC handlers call this.
 */
import {defaultSessionOptions} from '../../domain/launch/session-options';
import {rewriteTranscriptCwd, sessionCheckout} from '../../domain/agent/session-handoff';
import type {SessionCheckout} from '../../domain/agent/session-handoff';
import {isRemoteProjectPath, parseRemoteProjectPath} from '../../domain/project/remote-target';
import type {RemoteConfig} from '../../domain/project/remote-target';
import type {Session} from '../../domain/session/session';
import type {Clock, Timers} from '../ports/clock';
import type {Disposable} from '../ports/git-workspace';
import type {HandoffGit} from '../ports/handoff-git';
import type {Logger} from '../ports/logger';
import type {RendererGateway} from '../ports/renderer-gateway';
import type {SessionPrompter} from '../ports/session-prompter';
import type {TranscriptStore} from '../ports/transcript-store';
import {HOST_REACH_TIMEOUT_MS} from './agent-hosts-service';
import {isAgentPty} from './agent-client/agent-pty';
import type {PtyHandle} from '../ports/terminal-gateway';
import type {HandoffOptions, PreviewOptions} from './project-handoff-service';
import {withTimeout} from './project-handoff-service';
import type {HandoffPreview, HandoffResult} from './project-handoff';
import type {OpenSessionRequest, OpenSessionResult} from './session-launcher';
import type {SessionHandoff, SessionHandoffPhase, SessionHandoffPreview} from './session-handoff';
import type {SettingsService} from './settings-service';
import {STOP_ESCALATE_MS, STOP_GIVE_UP_MS} from './session-lifecycle';

/**
 * How long the hand-off waits for the stopped session's process to end. The
 * lifecycle's own escalation retires the record after SIGTERM, SIGKILL and a
 * give-up, so this only catches a stop that never reached the lifecycle.
 */
export const STOP_WAIT_MS = STOP_ESCALATE_MS + STOP_GIVE_UP_MS + 2000;

/** The most of a transcript one hand-off carries; past it, the upload would not be the right tool. */
export const TRANSCRIPT_CAP_BYTES = 256 * 1024 * 1024;

/** A running session, as far as the hand-off reads it. */
export interface HandoffSessionView {
    readonly pty: PtyHandle;
    readonly projectPath: string;
    readonly projectFolder: string | null;
    readonly isPlainTerminal: boolean;
    readonly exited: boolean;
    /** A legacy ssh+tmux session's connection state; null for a local or VM session. */
    readonly remote: unknown;
}

/**
 * The agent link, as far as carrying a transcript needs it. A small interface
 * of its own so this service does not wait for `AgentConnection` to grow
 * `importTranscript`: once it has, an `AgentConnection` is one of these.
 */
export interface TranscriptCarrier {
    whenConnected(): Promise<void>;
    upload(bytes: Uint8Array, options: {sha256: string}): Promise<string>;
    /** Send `import-transcript` and answer its `done`. */
    importTranscript(sessionId: string, dir: string, uploadId: string): Promise<{ok: boolean; error?: string}>;
}

/** The project hand-off, with the worktree option the session hand-off needs. */
export interface CheckoutHandoff {
    preview(localPath: string, options?: PreviewOptions): Promise<HandoffPreview | {error: string}>;
    handOff(
        localPath: string,
        hostKey: string,
        ticked: string[],
        onProgress?: (line: string) => void,
        options?: HandoffOptions,
    ): Promise<HandoffResult>;
}

export interface SessionHandoffServiceDeps {
    /** The running sessions (the `SessionRegistry`). */
    registry: {find(sessionId: string): {key: string; session: HandoffSessionView} | null};
    /** The indexed sessions, for one that has ended (the `SessionRepository`'s cache). */
    sessions: {getCachedSession(sessionId: string): Pick<Session, 'folder' | 'projectPath'> | null};
    transcripts: Pick<TranscriptStore, 'locations' | 'readTail'>;
    git: Pick<HandoffGit, 'repositoryRoot' | 'commonDir'>;
    projects: CheckoutHandoff;
    /** The link to a VM's agent (the `AgentClient`). */
    agents: {connection(host: RemoteConfig): TranscriptCarrier};
    /** Busy, idle and exit, as the lifecycle tells them (the `PtySessionPrompter`). */
    prompter: Pick<SessionPrompter, 'runningId' | 'isBusy' | 'onIdle' | 'onExit'>;
    /** Stop a session as the renderer's Stop does (`stopSession`). */
    stop(sessionId: string): {ok: boolean};
    launcher: {open(request: OpenSessionRequest): Promise<OpenSessionResult>};
    settings: Pick<SettingsService, 'effective' | 'touchRemoteSession' | 'handedOffSession' | 'recordHandedOffSession'>;
    renderer: Pick<RendererGateway, 'sessionStarted'>;
    /** SHA-256 of the bytes, hex, for the agent to check the upload against (no `node:` here). */
    sha256(bytes: Uint8Array): string;
    clock: Clock;
    timers: Timers;
    log: Logger;
}

/** A session that can be handed off, worked out once for the preview and the hand-off alike. */
interface Handable {
    /** The id the session goes by now, which it keeps on the VM. */
    sessionId: string;
    /** The local project: the session's own when it is the repository's, else the main checkout. */
    localPath: string;
    checkout: SessionCheckout;
    /** The transcript's folder under `~/.claude/projects`. */
    folder: string;
    /** The checkout as the transcript's `cwd` names it, which the rewrite moves. */
    transcriptRoot: string;
    running: boolean;
}

/** A hand-off in flight: `cancel` is set only while it waits for the turn to end. */
interface InFlight {
    cancel: (() => void) | null;
}

export class SessionHandoffService implements SessionHandoff {
    private readonly inFlight = new Map<string, InFlight>();

    constructor(private readonly deps: SessionHandoffServiceDeps) {}

    public async preview(sessionId: string): Promise<SessionHandoffPreview | {error: string}> {
        const handable = await this.handable(sessionId);
        if ('error' in handable) return handable;
        const {checkout, localPath} = handable;
        const preview = await this.deps.projects.preview(
            localPath,
            checkout.kind === 'worktree' ? {checkout: checkout.checkout} : {},
        );
        if ('error' in preview) return preview;
        return {
            localPath,
            worktree: checkout.kind === 'worktree' ? checkout.name : null,
            branch: preview.branch,
            unpushed: preview.unpushed,
            uncommitted: preview.uncommitted,
            candidates: preview.candidates,
            busy: handable.running && this.deps.prompter.isBusy(handable.sessionId),
        };
    }

    public async handOff(
        sessionId: string,
        hostKey: string,
        ticked: string[],
        onPhase: (phase: SessionHandoffPhase) => void = () => {},
    ): Promise<SessionHandoffPhase> {
        const emit = (phase: SessionHandoffPhase): SessionHandoffPhase => {
            onPhase(phase);
            return phase;
        };
        const id = this.deps.prompter.runningId(sessionId) ?? sessionId;
        if (this.inFlight.has(id) || this.inFlight.has(sessionId)) {
            return emit({kind: 'failed', error: 'This session is already being handed off.'});
        }
        const flight: InFlight = {cancel: null};
        this.inFlight.set(id, flight);
        try {
            return emit(await this.run(id, hostKey, ticked, flight, emit));
        } catch (err) {
            this.deps.log.error(`[session-handoff] ${id} failed:`, (err as Error).message);
            return emit({kind: 'failed', error: (err as Error).message});
        } finally {
            this.inFlight.delete(id);
        }
    }

    public cancel(sessionId: string): boolean {
        const id = this.deps.prompter.runningId(sessionId) ?? sessionId;
        const flight = this.inFlight.get(id) ?? this.inFlight.get(sessionId);
        if (!flight?.cancel) return false;
        flight.cancel();
        return true;
    }

    // ── The hand-off ──

    private async run(
        sessionId: string,
        hostKey: string,
        ticked: string[],
        flight: InFlight,
        emit: (phase: SessionHandoffPhase) => void,
    ): Promise<Exclude<SessionHandoffPhase, {kind: 'waiting'} | {kind: 'running'}>> {
        const {projects, settings, log} = this.deps;
        const first = await this.handable(sessionId);
        if ('error' in first) return {kind: 'failed', error: first.error};

        if (first.running && this.deps.prompter.isBusy(first.sessionId)) {
            emit({kind: 'waiting'});
            const went = await this.turnEnded(first.sessionId, flight);
            if (went === 'cancelled') {
                log.info(`[session-handoff] ${sessionId} cancelled while waiting for its turn to end`);
                return {kind: 'cancelled'};
            }
        }
        flight.cancel = null;

        // Looked at again: the turn may have moved the session (a fork re-keys
        // it) or ended it, and the transcript has grown.
        const handable = await this.handable(sessionId);
        if ('error' in handable) return {kind: 'failed', error: handable.error};
        const {checkout, localPath} = handable;
        const line = (text: string) => emit({kind: 'running', line: text});

        const handed = await projects.handOff(
            localPath,
            hostKey,
            ticked,
            line,
            checkout.kind === 'worktree' ? {worktree: {name: checkout.name, checkout: checkout.checkout}} : {},
        );
        if (!handed.ok) return {kind: 'failed', error: handed.error};
        const {copyPath} = handed;
        const copy = parseRemoteProjectPath(copyPath);
        if (!copy?.dir) return {kind: 'failed', error: `The copy's project path names no folder: ${copyPath}`};

        line('Carrying the conversation over');
        const carried = await this.carryTranscript(handable, copy, copy.dir);
        if (!carried.ok) return {kind: 'failed', error: carried.error};

        if (this.deps.prompter.runningId(handable.sessionId)) {
            line('Stopping the session on this Mac');
            const stopped = await this.stopHere(handable.sessionId);
            if (!stopped.ok) return {kind: 'failed', error: stopped.error};
        }

        // From here the conversation lives on the VM.
        const at = new Date(this.deps.clock.now()).toISOString();
        settings.recordHandedOffSession(handable.sessionId, copyPath, at);
        settings.touchRemoteSession(copyPath, handable.sessionId, 'claude', at);

        line('Resuming the conversation on the VM');
        const resumed = await this.resumeOnVm(handable.sessionId, copyPath);
        if (!resumed.ok) {
            log.warn(`[session-handoff] ${handable.sessionId} stopped here but did not resume on ${copyPath}`);
            return {
                kind: 'failed',
                error:
                    `The session stopped on this Mac and its conversation is on the VM, but it did not resume there: ` +
                    `${resumed.error}. Its row now opens on the VM, where Resume tries again; ` +
                    `the transcript is still on this Mac too.`,
            };
        }
        this.deps.renderer.sessionStarted(handable.sessionId, copyPath);
        log.info(`[session-handoff] ${handable.sessionId} → ${copyPath}`);
        return {kind: 'done', copyPath};
    }

    /**
     * Whether `sessionId` can be handed off, and what it would carry: a local
     * Claude session, running or ended, with a transcript on this Mac, in a git
     * checkout, not handed off already.
     */
    private async handable(sessionId: string): Promise<Handable | {error: string}> {
        const {registry, sessions, transcripts, git, settings} = this.deps;
        const found = registry.find(sessionId);
        const live = found && !found.session.exited ? found : null;
        const id = live?.key ?? sessionId;

        if (live) {
            const {session} = live;
            if (session.isPlainTerminal) return {error: 'A terminal has no conversation to hand off.'};
            if (session.remote || isAgentPty(session.pty) || isRemoteProjectPath(session.projectPath)) {
                return {error: 'This session already runs on another machine.'};
            }
        }
        if (settings.handedOffSession(id)) return {error: 'This session has been handed off to a VM already.'};

        const cached = sessions.getCachedSession(id);
        const projectPath = live?.session.projectPath ?? cached?.projectPath ?? null;
        if (!projectPath) return {error: 'Switchboard does not know this session.'};
        if (isRemoteProjectPath(projectPath)) return {error: 'This session already runs on another machine.'};
        const folder = live?.session.projectFolder ?? cached?.folder ?? null;
        if (!folder) return {error: 'This session has no transcript on this Mac yet.'};

        const written = transcripts.locations(folder, id).filter((location) => !location.fromSubagent);
        const cwd = written.length ? written[written.length - 1].cwd : null;
        if (!cwd) return {error: 'This session has no transcript on this Mac yet.'};

        const [toplevel, commonDir] = await Promise.all([git.repositoryRoot(cwd), git.commonDir(cwd)]);
        if (!toplevel || !commonDir) {
            return {error: `${cwd} is not a git checkout (any more), so there is nothing to hand off.`};
        }
        const checkout = sessionCheckout(toplevel, commonDir);
        if ('error' in checkout) return checkout;

        const projectRoot = await git.repositoryRoot(projectPath);
        const localPath = projectRoot === checkout.root ? projectPath : checkout.root;
        // The transcript may name the checkout through a symlink git resolved
        // (`/tmp` for `/private/tmp`); a `cwd` that is not under git's answer is
        // taken to be the checkout itself, as it is for every session Claude starts.
        const transcriptRoot = cwd === toplevel || cwd.startsWith(toplevel + '/') ? toplevel : cwd;
        return {sessionId: id, localPath, checkout, folder, transcriptRoot, running: live !== null};
    }

    /** Resolve when the session comes to its prompt or ends; or 'cancelled' when `cancel` is called first. */
    private turnEnded(sessionId: string, flight: InFlight): Promise<'idle' | 'cancelled'> {
        const {prompter} = this.deps;
        return new Promise((resolve) => {
            const subscriptions: Disposable[] = [];
            const settle = (how: 'idle' | 'cancelled') => {
                subscriptions.forEach((subscription) => subscription.dispose());
                flight.cancel = null;
                resolve(how);
            };
            flight.cancel = () => settle('cancelled');
            subscriptions.push(prompter.onIdle(sessionId, () => settle('idle')));
            subscriptions.push(prompter.onExit(sessionId, () => settle('idle')));
            // It may have gone idle between the caller's look and the subscription.
            if (!prompter.runningId(sessionId) || !prompter.isBusy(sessionId)) settle('idle');
        });
    }

    /** The transcript, moved to `dir`, uploaded and imported on the copy's host. */
    private async carryTranscript(
        handable: Handable,
        host: RemoteConfig,
        dir: string,
    ): Promise<{ok: true} | {ok: false; error: string}> {
        const {transcripts, agents, timers, sha256} = this.deps;
        const raw = transcripts.readTail(handable.folder, handable.sessionId, TRANSCRIPT_CAP_BYTES + 1);
        if (!raw) return {ok: false, error: 'Could not read the session’s transcript on this Mac.'};
        if (Buffer.byteLength(raw) > TRANSCRIPT_CAP_BYTES) {
            return {ok: false, error: 'The session’s transcript is too big to hand off.'};
        }
        const bytes = Buffer.from(rewriteTranscriptCwd(raw, handable.transcriptRoot, dir));
        const connection = agents.connection(host);
        try {
            await withTimeout(connection.whenConnected(), HOST_REACH_TIMEOUT_MS, timers);
            const uploadId = await connection.upload(bytes, {sha256: sha256(bytes)});
            const imported = await connection.importTranscript(handable.sessionId, dir, uploadId);
            if (!imported.ok) {
                return {
                    ok: false,
                    error: `The VM did not take the conversation: ${imported.error || 'no reason given'}`,
                };
            }
            return {ok: true};
        } catch (err) {
            return {ok: false, error: `Could not carry the conversation over: ${(err as Error).message}`};
        }
    }

    /** Stop the local session and wait for its process to end. */
    private async stopHere(sessionId: string): Promise<{ok: true} | {ok: false; error: string}> {
        const {prompter, timers} = this.deps;
        let subscription: Disposable | null = null;
        const ended = new Promise<void>((resolve) => {
            subscription = prompter.onExit(sessionId, resolve);
        });
        try {
            const stopped = this.deps.stop(sessionId);
            if (!stopped.ok) return {ok: false, error: 'The session on this Mac did not stop.'};
            if (prompter.runningId(sessionId)) await withTimeout(ended, STOP_WAIT_MS, timers);
            return {ok: true};
        } catch {
            return {
                ok: false,
                error:
                    'The session on this Mac did not stop in time, so it carries on here. ' +
                    'The VM already has a copy of the conversation, which a second hand-off cannot replace.',
            };
        } finally {
            (subscription as Disposable | null)?.dispose();
        }
    }

    /** Open the session on the VM under its own id, as a resume from its row would. */
    private async resumeOnVm(sessionId: string, copyPath: string): Promise<{ok: true} | {ok: false; error: string}> {
        const options = {
            ...defaultSessionOptions(this.deps.settings.effective(copyPath)),
            type: 'remote' as const,
            remoteKind: 'claude' as const,
        };
        try {
            const opened = await this.deps.launcher.open({sessionId, projectPath: copyPath, isNew: false, options});
            return opened.ok ? {ok: true} : {ok: false, error: opened.error || 'the VM did not open it'};
        } catch (err) {
            return {ok: false, error: (err as Error).message};
        }
    }
}
