/**
 * The Mac's side of a session's Bring back from a VM (#276), behind the
 * `SessionBringBack` façade: a session hand-off (`SessionHandoffService`) run
 * the other way. In order:
 *
 * 1. **Wait for the turn to end**, as the hand-off does; cancellable while it
 *    waits. A VM session that runs on the agent but is not attached here is
 *    attached first, so it can be waited on and stopped like any other.
 * 2. **Check the VM checkout**: the copy, or the worktree of it the session
 *    works in. It must be on a branch. Its commits come back through git;
 *    what it has uncommitted comes back as a patch (step 5).
 * 3. **Ask about an existing branch.** When the branch is on this Mac already
 *    (the worktree a hand-off left behind, most often) and no choice was
 *    made, answer `existing` and change nothing. `reuse` brings the VM's
 *    commits into that checkout, fast-forward only; `replace` deletes its
 *    worktree and the branch first.
 * 4. **Fetch** the branch straight from the copy over the user's ssh (never
 *    through origin: nothing is pushed), and check it out in the worktree.
 * 5. **Stop the VM session** and wait for its process to end; then **carry
 *    its uncommitted changes** as one `git diff --binary` patch, untracked
 *    files included, applied here unstaged. Once they apply, the VM checkout
 *    is reset to its commit: its work is here now, and a later hand-off would
 *    otherwise take what it left as the VM's own and refuse.
 * 6. **Carry the transcript back**: read whole from the agent, every line's
 *    `cwd` moved to the Mac's checkout, written where `claude --resume` here
 *    finds it. An older copy of it in another folder is set aside, and so is
 *    the VM's, so the next hand-off can bring it there again.
 * 7. **Move the row**: the VM's session record goes, and so does a hand-off
 *    record that hid the local row.
 * 8. **Resume here** under the same id.
 *
 * Failure before step 5 leaves the VM session as it was (a `replace` has
 * deleted the local worktree by then, as the user chose). After it, the VM
 * session has stopped, and its row there resumes it until step 7; a resume
 * that fails here is reported, and the row's Resume tries again.
 *
 * One Bring back per session at a time; the IPC handlers call this.
 */
import {rewriteBroughtBackCwd, vmCheckout} from '../../domain/agent/session-bring-back';
import {absoluteDir} from '../../domain/agent/schedule-dirs';
import {defaultSessionOptions} from '../../domain/launch/session-options';
import type {ExistingBranch, ExistingBranchChoice} from '../../domain/project/branch-worktree';
import {parseRemoteProjectPath, remoteProjectPath} from '../../domain/project/remote-target';
import type {RemoteConfig} from '../../domain/project/remote-target';
import type {AgentSessionInfo} from '../../domain/agent/protocol';
import type {Session} from '../../domain/session/session';
import type {Clock, Timers} from '../ports/clock';
import type {GitWorkspace, GitWorktrees} from '../ports/git-workspace';
import type {HandoffGit} from '../ports/handoff-git';
import type {Logger} from '../ports/logger';
import type {RendererGateway} from '../ports/renderer-gateway';
import type {SessionPrompter} from '../ports/session-prompter';
import {HOST_REACH_TIMEOUT_MS} from './agent-hosts-service';
import {copyFetchUrl, copyRemoteName, withTimeout} from './project-handoff-service';
import type {OpenSessionRequest, OpenSessionResult} from './session-launcher';
import type {SessionBringBack, SessionBringBackPhase, SessionBringBackPreview} from './session-bring-back';
import {TRANSCRIPT_CAP_BYTES} from './session-handoff-service';
import type {HandoffSessionView} from './session-handoff-service';
import type {SettingsService} from './settings-service';
import {WORKTREES_DIR} from './support/branch-worktrees';
import {stopAndWait, turnEnded} from './support/session-turns';
import type {InFlight} from './support/session-turns';

/** How long one git on the VM may take while the changes are read and the checkout reset. */
const VM_GIT_TIMEOUT_MS = 60_000;

/** The most untracked files one Bring back carries; past it, a commit on the VM is the way. */
const MAX_UNTRACKED_FILES = 500;

/** Where Switchboard's own worktrees sit in a checkout: never carried as untracked files. */
const OWN_WORKTREES = '.claude/worktrees/';

/** The agent link, as far as a Bring back needs it (an `AgentConnection` is one). */
export interface BringBackLink {
    readonly home: string | null;
    whenConnected(): Promise<void>;
    listSessions(): Promise<AgentSessionInfo[]>;
    getTranscript(sessionId: string): Promise<{cwd: string} | null>;
    copyStatus(dir: string): Promise<{ok: boolean; error?: string; branch?: string | null; uncommitted?: string[]}>;
    readTranscript(sessionId: string, capBytes: number): Promise<Uint8Array | null>;
    /** Rename the session's transcript out of the way on the VM, once it is here. */
    setTranscriptAside(sessionId: string): Promise<{ok: boolean; error?: string}>;
    /** Run git on the VM, in `cwd` (absolute there), for the uncommitted changes and the reset after. */
    runTool(
        tool: 'git',
        cwd: string,
        args: readonly string[],
        options: {timeoutMs: number},
    ): Promise<{code: number; stdout: Uint8Array; stderr: string; truncated: boolean}>;
}

export interface SessionBringBackServiceDeps {
    /** The running sessions (the `SessionRegistry`). */
    registry: {find(sessionId: string): {key: string; session: HandoffSessionView} | null};
    /** The indexed sessions, for the folder an older local copy of the transcript is in. */
    sessions: {getCachedSession(sessionId: string): Pick<Session, 'folder'> | null};
    /** The local transcripts' writer (the `FileTranscriptStore`). */
    transcripts: {
        writeSession(projectPath: string, sessionId: string, text: string): string;
        setSessionAside(folder: string, sessionId: string): void;
    };
    handoffGit: Pick<HandoffGit, 'repositoryRoot' | 'fetchFromCopy' | 'addWorktree' | 'applyPatch'>;
    /** The Mac's own git, for what is on a branch already here and for deleting it. */
    git: Pick<GitWorkspace, 'branchExists' | 'worktrees'> &
        Pick<GitWorktrees, 'removeWorktree' | 'pruneWorktrees' | 'deleteBranch'>;
    /** The link to a VM's agent (the `AgentClient`). */
    agents: {connection(host: RemoteConfig): BringBackLink};
    prompter: Pick<SessionPrompter, 'runningId' | 'isBusy' | 'onIdle' | 'onExit'>;
    /** Stop a session as the renderer's Stop does (`stopSession`). */
    stop(sessionId: string): {ok: boolean};
    launcher: {open(request: OpenSessionRequest): Promise<OpenSessionResult>};
    settings: Pick<SettingsService, 'remoteProjects' | 'effective' | 'forgetRemoteSession' | 'forgetHandedOffSession'>;
    renderer: Pick<RendererGateway, 'sessionStarted' | 'projectsChanged'>;
    clock: Clock;
    timers: Timers;
    log: Logger;
    /** How long a question waits for the host's link; HOST_REACH_TIMEOUT_MS by default. */
    reachTimeoutMs?: number;
}

/** A VM session that can be brought back, as far as it is known before asking its VM. */
interface Bringable {
    sessionId: string;
    copyPath: string;
    copy: RemoteConfig & {dir: string};
    /** The local project the copy was handed off from. */
    localPath: string;
}

/** Everything a Bring back works from, once the VM and the Mac have both been asked. */
interface Planned extends Bringable {
    link: BringBackLink;
    home: string;
    /** The VM checkout the session works in, absolute there. */
    vmDir: string;
    branch: string;
    /** The paths the VM checkout has uncommitted, as `git status` names them; they come back as a patch. */
    uncommitted: string[];
    /** The local repository's main checkout. */
    root: string;
    /** Where a new worktree goes on this Mac. */
    target: string;
    existing: ExistingBranch | null;
    /** The session runs on the agent, attached here now if it was not. */
    running: boolean;
}

export class SessionBringBackService implements SessionBringBack {
    private readonly inFlight = new Map<string, InFlight>();

    constructor(private readonly deps: SessionBringBackServiceDeps) {}

    public async preview(sessionId: string): Promise<SessionBringBackPreview | {error: string}> {
        const planned = await this.plan(sessionId, {attach: false});
        if ('error' in planned) return planned;
        return {
            copyPath: planned.copyPath,
            localPath: planned.localPath,
            branch: planned.branch,
            worktree: planned.existing?.worktreePath ?? planned.target,
            existing: planned.existing,
            uncommitted: planned.uncommitted.length,
            busy: this.deps.prompter.isBusy(sessionId),
        };
    }

    public async bringBack(
        sessionId: string,
        existing?: ExistingBranchChoice,
        onPhase: (phase: SessionBringBackPhase) => void = () => {},
    ): Promise<SessionBringBackPhase> {
        const emit = (phase: SessionBringBackPhase): SessionBringBackPhase => {
            onPhase(phase);
            return phase;
        };
        if (this.inFlight.has(sessionId))
            return emit({kind: 'failed', error: 'This session is already on its way back.'});
        const flight: InFlight = {cancel: null};
        this.inFlight.set(sessionId, flight);
        try {
            return emit(await this.run(sessionId, existing, flight, emit));
        } catch (err) {
            this.deps.log.error(`[bring-back] ${sessionId} failed:`, (err as Error).message);
            return emit({kind: 'failed', error: (err as Error).message});
        } finally {
            this.inFlight.delete(sessionId);
        }
    }

    public cancel(sessionId: string): boolean {
        const flight = this.inFlight.get(sessionId);
        if (!flight?.cancel) return false;
        flight.cancel();
        return true;
    }

    // ── The Bring back ──

    private async run(
        sessionId: string,
        choice: ExistingBranchChoice | undefined,
        flight: InFlight,
        emit: (phase: SessionBringBackPhase) => void,
    ): Promise<Exclude<SessionBringBackPhase, {kind: 'waiting'} | {kind: 'running'}>> {
        const {prompter, log} = this.deps;
        const line = (text: string) => emit({kind: 'running', line: text});

        line('Checking the session on the VM');
        const first = await this.plan(sessionId, {attach: true});
        if ('error' in first) return {kind: 'failed', error: first.error};
        if (first.existing && !choice) return {kind: 'existing', existing: first.existing};

        if (first.running && prompter.isBusy(sessionId)) {
            emit({kind: 'waiting'});
            const went = await turnEnded(prompter, sessionId, flight);
            if (went === 'cancelled') {
                log.info(`[bring-back] ${sessionId} cancelled while waiting for its turn to end`);
                return {kind: 'cancelled'};
            }
        }
        flight.cancel = null;

        // Asked again: the turn may have committed, switched branch or left changes behind.
        const planned = await this.plan(sessionId, {attach: false});
        if ('error' in planned) return {kind: 'failed', error: planned.error};
        if (planned.existing && !choice) return {kind: 'existing', existing: planned.existing};

        const placed = await this.place(planned, choice, line);
        if (!placed.ok) return {kind: 'failed', error: placed.error};
        const checkout = placed.checkout;

        if (prompter.runningId(sessionId)) {
            line('Stopping the session on the VM');
            const stopped = await this.stopThere(sessionId);
            if (!stopped.ok) return {kind: 'failed', error: stopped.error};
        }

        // Read once the session has stopped, so nothing it writes is left behind.
        const changes = await this.carryChanges(planned, checkout, line);
        if (!changes.ok) return {kind: 'failed', error: changes.error};

        line('Carrying the conversation back');
        const carried = await this.carryTranscript(planned, checkout);
        if (!carried.ok) return {kind: 'failed', error: carried.error};

        // From here the conversation lives on this Mac.
        this.deps.settings.forgetRemoteSession(planned.copyPath, sessionId);
        this.deps.settings.forgetHandedOffSession(sessionId);
        this.deps.renderer.projectsChanged();
        await this.setVmTranscriptAside(planned);

        line('Resuming the conversation on this Mac');
        const resumed = await this.resumeHere(sessionId, checkout, planned.localPath);
        if (!resumed.ok) {
            log.warn(`[bring-back] ${sessionId} came back to ${checkout} but did not resume`);
            return {
                kind: 'failed',
                error:
                    `The session’s work and conversation are on this Mac in ${checkout}, but it did not resume: ` +
                    `${resumed.error}. Its row now opens here, where Resume tries again.`,
            };
        }
        this.deps.renderer.sessionStarted(sessionId, checkout);
        log.info(`[bring-back] ${planned.copyPath} ${sessionId} → ${checkout}`);
        return {kind: 'done', projectPath: checkout};
    }

    /**
     * Whether `sessionId` can be brought back, and what it would do: a Claude
     * session on a VM copy of a local project, on a branch with nothing
     * uncommitted. With `attach`, a session the agent runs that is not
     * attached here is attached, so it can be waited on and stopped.
     */
    private async plan(sessionId: string, {attach}: {attach: boolean}): Promise<Planned | {error: string}> {
        const bringable = this.bringable(sessionId);
        if ('error' in bringable) return bringable;
        const {copy, localPath} = bringable;

        let link: BringBackLink;
        try {
            link = this.deps.agents.connection(copy);
            await withTimeout(
                link.whenConnected(),
                this.deps.reachTimeoutMs ?? HOST_REACH_TIMEOUT_MS,
                this.deps.timers,
            );
        } catch (err) {
            return {error: `Could not reach ${hostLabel(copy)}: ${(err as Error).message}`};
        }
        const home = link.home;
        if (!home) return {error: `${hostLabel(copy)} did not say where its home folder is; update the agent.`};

        let info: AgentSessionInfo | undefined;
        let cwd: string | null = null;
        try {
            info = (await link.listSessions()).find((s) => s.sessionId === sessionId && s.alive);
            cwd = info?.cwd ?? (await link.getTranscript(sessionId))?.cwd ?? null;
        } catch (err) {
            return {error: `Could not ask ${hostLabel(copy)} about the session: ${(err as Error).message}`};
        }
        if (!cwd) return {error: 'The VM has no transcript of this session yet, so there is nothing to bring back.'};

        const checkout = vmCheckout(absoluteDir(cwd, home), absoluteDir(copy.dir, home));
        if ('error' in checkout) return checkout;

        let state;
        try {
            state = await link.copyStatus(checkout.dir);
        } catch (err) {
            return {error: `Could not read ${checkout.dir} on the VM: ${(err as Error).message}`};
        }
        if (!state.ok) return {error: state.error || `The VM could not read ${checkout.dir}.`};
        const branch = state.branch;
        if (!branch)
            return {error: 'The session’s checkout on the VM is on a detached HEAD; check out a branch first.'};
        const uncommitted = state.uncommitted ?? [];

        const root = await this.deps.handoffGit.repositoryRoot(localPath);
        if (!root) return {error: `${localPath} is no longer a git repository.`};
        const name = checkout.kind === 'worktree' ? checkout.name : branch;
        const target = root.replace(/\/+$/, '') + WORKTREES_DIR + name;
        const existing = await this.existingBranch(root, branch);

        let running = info !== undefined;
        if (running && attach && !this.deps.prompter.runningId(sessionId)) {
            const attached = await this.attach(sessionId, bringable.copyPath);
            if (!attached.ok) return {error: `Could not attach to the session on the VM: ${attached.error}`};
        }
        running = running || this.deps.prompter.runningId(sessionId) !== null;
        return {...bringable, link, home, vmDir: checkout.dir, branch, uncommitted, root, target, existing, running};
    }

    /** A VM Claude session whose project is a copy of a local one; or why it cannot be brought back. */
    private bringable(sessionId: string): Bringable | {error: string} {
        const found = this.deps.registry.find(sessionId);
        if (found?.session.isPlainTerminal) return {error: 'A terminal has no conversation to bring back.'};
        const owner = this.deps.settings
            .remoteProjects()
            .find((remote) => (remote.sessions ?? []).some((record) => record.sessionId === sessionId));
        if (!owner) return {error: 'This session does not run on a VM.'};
        const record = owner.sessions?.find((s) => s.sessionId === sessionId);
        if (record?.kind === 'shell') return {error: 'A terminal has no conversation to bring back.'};
        if (!owner.agent) return {error: 'Only a session on a VM with a Switchboard agent can be brought back.'};
        if (!owner.copyOf) {
            return {error: 'This VM project is not a copy of a project on this Mac, so there is nowhere to bring it.'};
        }
        const copyPath = remoteProjectPath(owner);
        const copy = parseRemoteProjectPath(copyPath);
        if (!copy?.dir) return {error: `The copy's project path names no folder: ${copyPath}`};
        return {sessionId, copyPath, copy: {...copy, dir: copy.dir}, localPath: owner.copyOf};
    }

    /** The branch on this Mac already: where it is checked out, and what is on it. Null when it is not here. */
    private async existingBranch(root: string, branch: string): Promise<ExistingBranch | null> {
        const {git} = this.deps;
        const checkout = (await git.worktrees(root)).find((worktree) => worktree.branch === branch) ?? null;
        if (!checkout && !(await git.branchExists(root, branch))) return null;
        return {
            branch,
            worktreePath: checkout?.path ?? null,
            main: checkout?.main ?? false,
            changedFiles: checkout?.changedFiles ?? 0,
            ahead: checkout?.ahead ?? 0,
            // The session that worked there is this one, on its way back.
            sessionId: null,
        };
    }

    /** Fetch the branch from the copy and check it out here as `choice` says; the checkout it is in. */
    private async place(
        planned: Planned,
        choice: ExistingBranchChoice | undefined,
        line: (text: string) => void,
    ): Promise<{ok: true; checkout: string} | {ok: false; error: string}> {
        const {handoffGit, git} = this.deps;
        const {root, branch, copy, existing, target} = planned;

        const remote = copyRemoteName(copy);
        line(`Fetching ${branch} from the VM`);
        const fetched = await handoffGit.fetchFromCopy(root, remote, copyFetchUrl(copy), branch);
        if (!fetched.ok) return {ok: false, error: `Could not fetch ${branch} from the VM: ${fetched.reason}`};
        const ref = `${remote}/${branch}`;

        if (existing && choice === 'reuse') {
            const at = existing.worktreePath ?? target;
            line(`Bringing the VM’s commits into ${at}`);
            const added = await handoffGit.addWorktree(root, at, branch, ref);
            if (!added.ok) {
                return {
                    ok: false,
                    error: `Could not update ${branch} in ${at}: ${added.reason}. Delete and recreate it to take the VM’s branch as it is.`,
                };
            }
            return {ok: true, checkout: at};
        }

        if (existing && choice === 'replace') {
            if (existing.main) {
                return {
                    ok: false,
                    error: `${branch} is checked out in the main checkout, which is never deleted; update it instead.`,
                };
            }
            if (existing.worktreePath) {
                line(`Deleting the worktree at ${existing.worktreePath}`);
                const removed = await git.removeWorktree(root, existing.worktreePath, {force: true});
                if (!removed.ok) return {ok: false, error: 'Could not delete the worktree: ' + removed.reason};
            }
            await git.pruneWorktrees(root);
            const deleted = await git.deleteBranch(root, branch);
            if (!deleted.ok) return {ok: false, error: `Could not delete branch ${branch}: ${deleted.reason}`};
        }

        line(`Checking ${branch} out in ${target}`);
        const added = await handoffGit.addWorktree(root, target, branch, ref);
        if (!added.ok) return {ok: false, error: `Could not add a worktree for ${branch}: ${added.reason}`};
        return {ok: true, checkout: target};
    }

    /**
     * The VM checkout's uncommitted changes, applied to `checkout` here, and
     * the VM checkout reset once they are: nothing when it has none. The VM is
     * reset only when what it has is still exactly what was applied.
     */
    private async carryChanges(
        planned: Planned,
        checkout: string,
        line: (text: string) => void,
    ): Promise<{ok: true} | {ok: false; error: string}> {
        const stopped = 'The session on the VM has stopped and its changes are still there; its row resumes it there.';
        const first = await this.vmChanges(planned);
        if (!first.ok) return {ok: false, error: `${first.error} ${stopped}`};
        if (first.patch.length === 0) return {ok: true};

        line(`Bringing back ${plural(first.count, 'uncommitted change')}`);
        const applied = await this.deps.handoffGit.applyPatch(checkout, first.patch);
        if (!applied.ok) {
            return {
                ok: false,
                error: `The VM’s uncommitted changes don’t apply to ${checkout}: ${applied.reason}. ${stopped}`,
            };
        }

        const again = await this.vmChanges(planned);
        if (!again.ok || Buffer.compare(Buffer.from(again.patch), Buffer.from(first.patch)) !== 0) {
            this.deps.log.warn(`[bring-back] ${planned.vmDir} changed while its changes were read; left as it is`);
            return {ok: true};
        }
        line('Resetting the checkout on the VM, whose changes are here now');
        const {link, vmDir} = planned;
        const run = (args: string[]) => link.runTool('git', vmDir, args, {timeoutMs: VM_GIT_TIMEOUT_MS});
        try {
            const reset = await run(['reset', '--hard', '--quiet']);
            // The untracked files that came back; never `-x`, which would take ignored files too.
            const cleaned =
                reset.code === 0 && first.untracked.length
                    ? await run(['clean', '-f', '--quiet', '--', ...first.untracked])
                    : reset;
            if (reset.code !== 0 || cleaned.code !== 0) {
                this.deps.log.warn(`[bring-back] could not reset ${vmDir}: ${reset.stderr || cleaned.stderr}`);
            }
        } catch (err) {
            this.deps.log.warn(`[bring-back] could not reset ${vmDir}: ${(err as Error).message}`);
        }
        return {ok: true};
    }

    /**
     * What the VM checkout has uncommitted, as one patch `git apply` takes:
     * the tracked changes against HEAD, then each untracked file (never
     * Switchboard's own worktrees, nor a nested repository) as a new file.
     */
    private async vmChanges(
        planned: Planned,
    ): Promise<{ok: true; patch: Uint8Array; count: number; untracked: string[]} | {ok: false; error: string}> {
        const {link, vmDir} = planned;
        const prefixes = [
            '--binary',
            '--no-color',
            '--no-ext-diff',
            '--no-textconv',
            '--src-prefix=a/',
            '--dst-prefix=b/',
        ];
        const run = (args: string[]) => link.runTool('git', vmDir, args, {timeoutMs: VM_GIT_TIMEOUT_MS});
        try {
            const tracked = await run(['diff', ...prefixes, 'HEAD']);
            if (tracked.code !== 0) return {ok: false, error: `Could not read the VM’s changes: ${tracked.stderr}`};
            if (tracked.truncated) return {ok: false, error: 'The VM’s uncommitted changes are too big to bring back.'};
            const listed = await run(['ls-files', '-z', '--others', '--exclude-standard']);
            if (listed.code !== 0) return {ok: false, error: `Could not list the VM’s new files: ${listed.stderr}`};
            const untracked = Buffer.from(listed.stdout)
                .toString('utf8')
                .split('\0')
                .filter((path) => path && !path.endsWith('/') && !path.startsWith(OWN_WORKTREES));
            if (untracked.length > MAX_UNTRACKED_FILES) {
                return {
                    ok: false,
                    error: `The VM checkout has ${untracked.length} new files; commit them there to bring them back.`,
                };
            }
            const parts: Uint8Array[] = [tracked.stdout];
            for (const path of untracked) {
                // Exits 1 when there is a difference, which a new file always is.
                const added = await run(['diff', '--no-index', ...prefixes, '--', '/dev/null', path]);
                if (added.code !== 1 && added.code !== 0) {
                    return {ok: false, error: `Could not read ${path} on the VM: ${added.stderr}`};
                }
                if (added.truncated) return {ok: false, error: `${path} on the VM is too big to bring back.`};
                parts.push(added.stdout);
            }
            const changed =
                Buffer.from(tracked.stdout)
                    .toString('utf8')
                    .match(/^diff --git /gm)?.length ?? 0;
            return {
                ok: true,
                patch: Buffer.concat(parts.map((part) => Buffer.from(part))),
                count: changed + untracked.length,
                untracked,
            };
        } catch (err) {
            return {ok: false, error: `Could not read the VM’s changes: ${(err as Error).message}`};
        }
    }

    /** The VM's transcript out of the way, so the next hand-off can bring the conversation there again. */
    private async setVmTranscriptAside(planned: Planned): Promise<void> {
        try {
            const done = await planned.link.setTranscriptAside(planned.sessionId);
            if (!done.ok) this.deps.log.warn(`[bring-back] VM kept ${planned.sessionId}'s transcript: ${done.error}`);
        } catch (err) {
            this.deps.log.warn(`[bring-back] VM kept ${planned.sessionId}'s transcript: ${(err as Error).message}`);
        }
    }

    /** Attach to a session the agent runs, as opening its row would. */
    private async attach(sessionId: string, copyPath: string): Promise<{ok: true} | {ok: false; error: string}> {
        try {
            const opened = await this.deps.launcher.open({
                sessionId,
                projectPath: copyPath,
                isNew: false,
                options: {
                    ...defaultSessionOptions(this.deps.settings.effective(copyPath)),
                    type: 'remote' as const,
                    remoteKind: 'claude' as const,
                },
            });
            return opened.ok ? {ok: true} : {ok: false, error: opened.error || 'the VM did not open it'};
        } catch (err) {
            return {ok: false, error: (err as Error).message};
        }
    }

    /** Stop the VM session and wait for its process to end. */
    private async stopThere(sessionId: string): Promise<{ok: true} | {ok: false; error: string}> {
        try {
            const stopped = await stopAndWait(this.deps.prompter, this.deps.timers, this.deps.stop, sessionId);
            return stopped ? {ok: true} : {ok: false, error: 'The session on the VM did not stop.'};
        } catch {
            return {
                ok: false,
                error:
                    'The session on the VM did not stop in time, so it carries on there. ' +
                    'Its work is on this Mac already; bring it back again once it has stopped.',
            };
        }
    }

    /** The VM's transcript, moved to `checkout`, written where `claude --resume` here finds it. */
    private async carryTranscript(
        planned: Planned,
        checkout: string,
    ): Promise<{ok: true} | {ok: false; error: string}> {
        const {sessionId, link, vmDir, home} = planned;
        let bytes: Uint8Array | null;
        try {
            bytes = await link.readTranscript(sessionId, TRANSCRIPT_CAP_BYTES);
        } catch (err) {
            return {ok: false, error: `Could not carry the conversation back: ${(err as Error).message}`};
        }
        if (!bytes) return {ok: false, error: 'The VM has no transcript of this session.'};
        const text = rewriteBroughtBackCwd(Buffer.from(bytes).toString('utf8'), vmDir, home, checkout);
        try {
            const folder = this.deps.transcripts.writeSession(checkout, sessionId, text);
            const older = this.deps.sessions.getCachedSession(sessionId)?.folder;
            if (older && older !== folder) this.deps.transcripts.setSessionAside(older, sessionId);
            return {ok: true};
        } catch (err) {
            return {ok: false, error: `Could not write the conversation on this Mac: ${(err as Error).message}`};
        }
    }

    /** Open the session here under its own id, as a resume from its row would. */
    private async resumeHere(
        sessionId: string,
        checkout: string,
        localPath: string,
    ): Promise<{ok: true} | {ok: false; error: string}> {
        const options = defaultSessionOptions(this.deps.settings.effective(localPath));
        try {
            const opened = await this.deps.launcher.open({sessionId, projectPath: checkout, isNew: false, options});
            return opened.ok ? {ok: true} : {ok: false, error: opened.error || 'it did not open'};
        } catch (err) {
            return {ok: false, error: (err as Error).message};
        }
    }
}

function hostLabel(host: Pick<RemoteConfig, 'user' | 'host' | 'port'>): string {
    const port = Number(host.port) || 22;
    return `${host.user}@${host.host}${port === 22 ? '' : `:${port}`}`;
}

function plural(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
