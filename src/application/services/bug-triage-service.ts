/**
 * Quick triage (T) on the Bug manager page: a read-only errand session that
 * finds out what happened to a bug. The rules and the words are
 * `domain/inbox/triage`; this is their plumbing, after the Merge manager's
 * fix errands (`fix-errand-service`).
 *
 * - **Start** (`start`). The bug's Bugsnag project must be linked to a local
 *   project on this Mac (an ssh or VM project is refused). Its worktree,
 *   `.claude/worktrees/triage/bugsnag-<first 8 of the error id>`, is made
 *   detached at the default branch's tip, fetched first; offline it falls
 *   back to the last `origin/<default>` known, or HEAD. Triage again removes
 *   and makes it afresh, or reuses it as it is when git will not remove it.
 *   The triage is kept on the item before the session starts, so its first
 *   tool calls already find it, and pushed, so the Errands shelf shows it at
 *   once. The session starts in auto mode with read-only allow rules. A bug
 *   with a triage running answers as it is; a session that does not start
 *   leaves the triage stopped.
 * - **Finish** (`finish`, the `finish_triage` tool). The verdict is kept on
 *   the item and the session's archive is asked for. A read bug turns
 *   unread, so you see the verdict; an unread one stays unread, and one
 *   snoozed, in the backlog, in progress or done stays where you put it.
 *   `finish_triage` is offered to a triage's session only, and is taken from
 *   a stopped one too (you nudged it on, and it finished).
 * - **Stopped.** A turn that ends without `finish_triage` (and without asking
 *   to be archived), a session that waits on you (a permission prompt, a
 *   question), or one that ends: the triage is stopped, and shows on the
 *   Errands shelf as Needs you until it is triaged again, finishes after all,
 *   or its session is archived. Re-keys (a fork, a plan accept) are followed
 *   through `currentId`.
 */
import {localProjectFor} from '../../domain/bugsnag/connection';
import {
    isTriageSession,
    parseFinishTriageInput,
    triageAllowRules,
    triagePrompt,
    triageState,
    triageWorktree,
} from '../../domain/inbox/triage';
import {gitHubRepository} from '../../domain/project/repo-url';
import {isRemoteProjectPath} from '../../domain/project/remote-target';
import type {BugTriage, InboxItem} from '../../domain/inbox/model';
import type {ArchiveToolOutcome} from '../../domain/session/archive-tool';
import type {SessionOptions} from '../../domain/launch/session-options';
import type {Clock} from '../ports/clock';
import type {GitWorkspace, GitWorktrees} from '../ports/git-workspace';
import type {GitRemotes} from '../ports/git-remotes';
import type {IdGenerator} from '../ports/ids';
import type {Logger} from '../ports/logger';
import type {BugsnagConnectionService} from './bugsnag-connection-service';
import type {InboxService} from './inbox-service';

export type TriageStartResult = {ok: true; item: InboxItem} | {ok: false; reason: string};

/** What the bug's detail pane read, the part a triage prompt uses. */
export interface TriageDetail {
    url: string | null;
    frames: {line: string; inProject: boolean}[];
}

export interface BugTriageServiceDeps {
    inbox: Pick<InboxService, 'item' | 'list' | 'update'>;
    bugsnag: Pick<BugsnagConnectionService, 'settings'>;
    git: Pick<GitWorkspace, 'defaultBranch' | 'commitSha' | 'worktrees'> &
        Pick<
            GitWorktrees,
            'mainCheckout' | 'fetchBranch' | 'addDetachedWorktree' | 'removeWorktree' | 'pruneWorktrees'
        >;
    remotes: GitRemotes;
    /** The bug's dashboard URL and top frames, as the detail pane reads them; null when not read. */
    detail?: (key: string) => Promise<TriageDetail | null>;
    /** Start the triage's session in its worktree, with these options, and give it a row. */
    sessions: {
        start(request: {
            sessionId: string;
            worktree: string;
            options: SessionOptions;
        }): Promise<{ok: true} | {ok: false; reason: string}>;
    };
    /** Ask for the session's archive at the end of its turn (`archive_session`'s request). */
    archive: {request(launchId: string): ArchiveToolOutcome};
    ids: IdGenerator;
    clock: Clock;
    log: Logger;
}

export class BugTriageService {
    /** Bugs whose triage is being started, so a second T does not start another. */
    private readonly starting = new Set<string>();

    constructor(private readonly deps: BugTriageServiceDeps) {}

    /** Is this session a triage's that has not finished? Only those are offered `finish_triage`. */
    public isTriage(launchId: string): boolean {
        return this.open(launchId) !== null;
    }

    // ── Start ──

    /** T on the bug at `key`: start its triage, or answer the one running. */
    public async start(key: string): Promise<TriageStartResult> {
        const item = this.deps.inbox.item(key);
        if (!item || item.facts.kind !== 'bug') return {ok: false, reason: 'That bug is no longer in the inbox.'};
        if (this.starting.has(key) || (item.triage && triageState(item.triage) === 'running')) return {ok: true, item};
        this.starting.add(key);
        try {
            return await this.launch(item);
        } catch (err) {
            this.deps.log.warn(`[bug-triage] ${key}: no triage started,`, (err as Error).message);
            return {ok: false, reason: `The triage did not start: ${(err as Error).message || 'it failed'}`};
        } finally {
            this.starting.delete(key);
        }
    }

    private async launch(item: InboxItem): Promise<TriageStartResult> {
        if (item.facts.kind !== 'bug') return {ok: false, reason: 'That bug is no longer in the inbox.'};
        const {git, clock, log} = this.deps;
        const facts = item.facts;
        const local = localProjectFor(this.deps.bugsnag.settings(), facts.projectId);
        if (!local) return {ok: false, reason: 'Link a project first: Settings → Bug manager.'};
        if (isRemoteProjectPath(local)) return {ok: false, reason: 'Triage runs on this Mac only.'};
        const root = await git.mainCheckout(local);
        if (!root) return {ok: false, reason: `Not a git repository: ${local}`};
        const origin = await this.deps.remotes.originUrl(root);
        const repository = (origin ? gitHubRepository(origin) : '') || folderName(root);

        const worktree = triageWorktree(root, facts.errorId);
        const made = await this.makeWorktree(root, worktree);
        if (!made.ok) return {ok: false, reason: made.reason};

        const detail = await this.deps.detail?.(item.key).catch(() => null);
        const prompt = triagePrompt(facts, {
            projectName: this.projectName(facts.projectId),
            worktree,
            ref: made.ref,
            url: detail?.url ?? null,
            frames: detail?.frames.filter((frame) => frame.inProject).map((frame) => frame.line) ?? [],
        });
        const sessionId = this.deps.ids.newId();
        const triage: BugTriage = {
            sessionId,
            currentId: sessionId,
            worktree,
            repository,
            startedAt: clock.now(),
            verdict: null,
            stoppedAt: null,
        };
        // Kept before the session starts, so its first calls already find it.
        this.deps.inbox.update(item.key, (current) => ({...current, triage}));
        const started = await this.deps.sessions.start({
            sessionId,
            worktree,
            options: {permissionMode: 'auto', initialPrompt: prompt, allowedTools: triageAllowRules()},
        });
        if (!started.ok) {
            this.setTriage(item.key, sessionId, (kept) => ({...kept, stoppedAt: clock.now()}));
            log.warn(`[bug-triage] ${item.key}: its session did not start, ${started.reason}`);
            return {ok: false, reason: `The triage did not start: ${started.reason}`};
        }
        log.info(`[bug-triage] ${item.key} triage started as session=${sessionId} in ${worktree}`);
        return {ok: true, item: this.deps.inbox.item(item.key) ?? item};
    }

    /**
     * The triage's worktree, made afresh at the default branch's tip: fetched
     * first, else the last `origin/<default>` known, else HEAD. One git will
     * not remove (changes in it, locked) is reused as it is.
     */
    private async makeWorktree(
        root: string,
        path: string,
    ): Promise<{ok: true; ref: string} | {ok: false; reason: string}> {
        const {git, log} = this.deps;
        const trunk = await git.defaultBranch(root);
        let ref = `origin/${trunk}`;
        const fetched = await git.fetchBranch(root, trunk);
        if (!fetched.ok) {
            log.warn(`[bug-triage] ${trunk} not fetched in ${root}:`, fetched.reason);
            if (!(await git.commitSha(root, ref))) ref = 'HEAD';
        }
        const listed = (await git.worktrees(root)).some((tree) => samePath(tree.path, path));
        if (listed) {
            const removed = await git.removeWorktree(root, path);
            if (!removed.ok) {
                log.warn(`[bug-triage] ${path} kept as it is:`, removed.reason);
                return {ok: true, ref: 'HEAD'};
            }
        } else {
            // A worktree whose directory went is still registered, and would refuse the add.
            await git.pruneWorktrees(root);
        }
        const added = await git.addDetachedWorktree(root, path, ref);
        if (!added.ok) return {ok: false, reason: `Its worktree could not be made: ${added.reason}`};
        return {ok: true, ref};
    }

    // ── Finish ──

    /** `finish_triage` from the session launched as `launchId`. */
    public finish(launchId: string, args: unknown): ArchiveToolOutcome {
        const item = this.open(launchId);
        if (!item?.triage) return {ok: false, message: 'This session is not a triage, so nothing was recorded.'};
        const input = parseFinishTriageInput(args);
        if (!input.ok) return {ok: false, message: input.message};

        const at = this.deps.clock.now();
        const sessionId = item.triage.sessionId;
        this.deps.inbox.update(item.key, (current) => {
            if (!current.triage || current.triage.sessionId !== sessionId) return current;
            return {
                ...current,
                triage: {...current.triage, verdict: {...input.verdict, at}, stoppedAt: null},
                // A read bug comes back, so the verdict is seen; any other place you put it stands.
                state: current.state.kind === 'read' ? {kind: 'unread'} : current.state,
            };
        });
        this.deps.log.info(
            `[bug-triage] ${item.key} triaged: ${input.verdict.suggestion} (${input.verdict.confidence})`,
        );
        const archive = this.deps.archive.request(launchId);
        return {
            ok: true,
            message:
                `Recorded: ${input.verdict.suggestion}. ` +
                (archive.ok ? archive.message : 'This session could not be archived; it stays as it is.'),
        };
    }

    // ── Stopped ──

    /**
     * A turn of a running session ended, under any of the ids it has gone by:
     * a triage's that did not finish, and did not ask to be archived, stopped.
     * `currentId` is kept.
     */
    public turnEnded(sessionIds: readonly string[], archiving: boolean, currentId?: string): void {
        for (const item of this.deps.inbox.list('bug')) {
            const triage = item.triage;
            if (!triage || !sessionIds.some((id) => isTriageSession(triage, id))) continue;
            if (currentId && currentId !== triage.currentId) {
                this.setTriage(item.key, triage.sessionId, (kept) => ({...kept, currentId}));
            }
            if (!archiving && triageState(triage) === 'running') {
                this.stop(item.key, triage, 'its turn ended without finish_triage');
            }
        }
    }

    /** A session is blocked on you (a permission prompt, a question). */
    public needsAttention(sessionId: string): void {
        this.stopRunning(sessionId, 'it is waiting for you');
    }

    /** A session ended. */
    public sessionEnded(sessionId: string): void {
        this.stopRunning(sessionId, 'its session ended without finish_triage');
    }

    private stopRunning(sessionId: string, why: string): void {
        for (const item of this.deps.inbox.list('bug')) {
            const triage = item.triage;
            if (triage && isTriageSession(triage, sessionId) && triageState(triage) === 'running') {
                this.stop(item.key, triage, why);
            }
        }
    }

    private stop(key: string, triage: BugTriage, why: string): void {
        this.setTriage(key, triage.sessionId, (kept) => ({...kept, stoppedAt: this.deps.clock.now()}));
        this.deps.log.info(`[bug-triage] ${key} triage stopped: ${why}`);
    }

    // ── Helpers ──

    /** The bug whose unfinished triage the session is. */
    private open(launchId: string): InboxItem | null {
        return (
            this.deps.inbox
                .list('bug')
                .find(
                    (item) =>
                        item.triage &&
                        isTriageSession(item.triage, launchId) &&
                        triageState(item.triage) !== 'finished',
                ) ?? null
        );
    }

    /** Change the item's triage, only while it is still the one launched as `sessionId`. */
    private setTriage(key: string, sessionId: string, change: (triage: BugTriage) => BugTriage): void {
        this.deps.inbox.update(key, (item) =>
            item.triage && item.triage.sessionId === sessionId ? {...item, triage: change(item.triage)} : item,
        );
    }

    private projectName(projectId: string): string {
        return this.deps.bugsnag.settings().projects.find((project) => project.id === projectId)?.name || projectId;
    }
}

function samePath(a: string, b: string): boolean {
    return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

function folderName(path: string): string {
    return path.replace(/\/+$/, '').split('/').pop() || path;
}
