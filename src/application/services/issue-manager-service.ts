/**
 * The Issue manager page's work in main (#415, for #409): an issue's thread,
 * a comment Claude polishes from your notes, Start and claim, Stop working on
 * it, and where each started issue stands.
 *
 * What it writes to GitHub, each only from you pressing something: Start
 * assigns you, Post writes the comment, and Stop takes you off the issue
 * again when you ask it to. Everything else is the inbox's own state.
 *
 * **Start and claim** assigns you (`gh issue edit --add-assignee @me`), reads
 * the ticket and its thread, and makes the issue's worktree with a prompt
 * that carries them and your notes (`prepareLooseIssueWorktree`). The session
 * itself is the renderer's to start, which then says so (`started`), and the
 * item moves to In progress. An issue whose branch exists already is
 * continued on it.
 *
 * **Following.** Every two minutes while issues are in progress, each of
 * their repositories' PRs are read once: the PR that closes an issue gives
 * its stage (PR · CI, CI failing, Ready, Queue), and a merged one puts it
 * under Done ("Closed by #n").
 */
import {
    POLISH_TIMEOUT_MS,
    issueWorkStage,
    polishArgs,
    polishFooter,
    polishPrompt,
    readPolishRun,
    withPolishFooter,
    type IssueThread,
} from '../../domain/inbox/issue-manager';
import type {InboxItem, IssueFacts} from '../../domain/inbox/model';
import type {ClaudeCaller} from '../ports/claude-cli';
import type {TimerHandle, Timers} from '../ports/clock';
import type {GitHubCli, IssueManagerCalls} from '../ports/github-cli';
import type {Logger} from '../ports/logger';
import type {InboxService} from './inbox-service';
import type {IssueSessionService} from './issue-session-service';

/** How often the started issues' PRs are read. */
export const ISSUE_WORK_POLL_MS = 2 * 60_000;

/** A comment polished from your notes, with the line posting adds after it; or why there is none. */
export type PolishResult = {ok: true; body: string; footer: string} | {ok: false; reason: string};

export type IssueWriteResult = {ok: true} | {ok: false; reason: string};

/** A started issue's worktree and prompt, for the renderer to start its session in; or why there is none. */
export type IssueStartPrepared =
    | {ok: true; projectPath: string; worktreePath: string; branch: string; prompt: string; warning?: string}
    | {ok: false; reason: string};

export interface IssueManagerServiceDeps {
    inbox: Pick<
        InboxService,
        'item' | 'list' | 'startWork' | 'setWork' | 'setStage' | 'finish' | 'returnToInbox' | 'projectFor'
    >;
    github: Pick<GitHubCli, IssueManagerCalls | 'pullRequestsIn'>;
    issueSessions: Pick<IssueSessionService, 'prepareLooseIssueWorktree'>;
    cli: Pick<ClaudeCaller, 'call'>;
    timers: Timers;
    log: Logger;
}

export class IssueManagerService {
    /** The user `gh` signs in as, once a thread said. */
    private viewer: string | null = null;
    private interval: TimerHandle | null = null;
    private following: Promise<void> | null = null;

    constructor(private readonly deps: IssueManagerServiceDeps) {}

    /** Follow the started issues now and every two minutes after. */
    public start(): void {
        if (this.interval) return;
        this.interval = this.deps.timers.setInterval(() => void this.follow(), ISSUE_WORK_POLL_MS);
        void this.follow();
    }

    public stop(): void {
        this.deps.timers.clearInterval(this.interval);
        this.interval = null;
    }

    /** An issue's ticket and newest comments; null when it is not the Issue manager's or GitHub did not answer. */
    public async thread(key: string): Promise<IssueThread | null> {
        const facts = this.issue(key);
        if (!facts) return null;
        const thread = await this.deps.github.issueThread(facts.repository, facts.number);
        if (thread?.viewer) this.viewer = thread.viewer;
        return thread;
    }

    // ── Comment… (M) and Polish and post now (⇧M) ──

    /** Your notes polished into a comment, for the preview; with the footer posting adds. */
    public async polish(key: string, notes: string): Promise<PolishResult> {
        const facts = this.issue(key);
        if (!facts) return {ok: false, reason: 'That issue is no longer in the Issue manager'};
        if (!notes.trim()) return {ok: false, reason: 'Write some notes first'};
        const thread = await this.thread(key);
        const login = this.viewer;
        if (!thread || !login) return {ok: false, reason: 'Could not read the issue from GitHub'};
        const body = await this.callPolish(polishPrompt(facts, thread, notes));
        if (!body) return {ok: false, reason: 'Claude could not polish the notes'};
        return {ok: true, body, footer: polishFooter(login)};
    }

    /** Post a comment as it is, with the footer after it. Your notes stay as they were. */
    public async post(key: string, body: string): Promise<IssueWriteResult> {
        const facts = this.issue(key);
        if (!facts) return {ok: false, reason: 'That issue is no longer in the Issue manager'};
        if (!body.trim()) return {ok: false, reason: 'The comment is empty'};
        const login = this.viewer ?? (await this.thread(key))?.viewer ?? null;
        if (!login) return {ok: false, reason: 'Could not tell who you are on GitHub'};
        const posted = await this.deps.github.commentOnIssue(
            facts.repository,
            facts.number,
            withPolishFooter(body, login),
        );
        return posted.ok ? {ok: true} : {ok: false, reason: posted.reason};
    }

    /** Polish and post straight away, without the preview. */
    public async polishAndPost(key: string, notes: string): Promise<IssueWriteResult> {
        const polished = await this.polish(key, notes);
        if (!polished.ok) return polished;
        return this.post(key, polished.body);
    }

    private async callPolish(prompt: string): Promise<string | null> {
        const {cli, timers, log} = this.deps;
        const controller = new AbortController();
        let timer: TimerHandle = null;
        const timedOut = new Promise<null>((resolve) => {
            timer = timers.setTimeout(() => {
                log.warn('[issue-manager] the polish timed out');
                resolve(null);
            }, POLISH_TIMEOUT_MS);
        });
        const answered = cli.call(polishArgs(prompt), controller.signal).then(
            (run) => {
                const text = readPolishRun(run);
                if (text === null) log.warn('[issue-manager] the polish failed');
                return text;
            },
            (err: Error) => {
                log.warn('[issue-manager] could not run the polish:', err.message);
                return null;
            },
        );
        try {
            return await Promise.race([answered, timedOut]);
        } finally {
            timers.clearTimeout(timer);
            controller.abort();
        }
    }

    // ── Start and claim (⏎) ──

    /**
     * Claim the issue and make its worktree: assigned to you, then a branch
     * named after it with the ticket, its thread and your notes in the
     * prompt. A failed claim still starts, with a warning to show.
     */
    public async prepareStart(key: string): Promise<IssueStartPrepared> {
        const item = this.deps.inbox.item(key);
        const facts = item?.facts.kind === 'issue' ? item.facts : null;
        if (!item || !facts) return {ok: false, reason: 'That issue is no longer in the Issue manager'};
        const projectPath = await this.deps.inbox.projectFor(facts.repository);
        if (!projectPath) return {ok: false, reason: `No project with Watch issues on is ${facts.repository}`};

        const claimed = await this.deps.github.assignSelf(facts.repository, facts.number);
        const thread = await this.thread(key);
        const prepared = await this.deps.issueSessions.prepareLooseIssueWorktree({
            projectPath,
            issue: {repository: facts.repository, number: facts.number},
            ticket: {
                title: facts.title,
                author: facts.author,
                body: thread?.body ?? '',
                comments: thread?.comments ?? [],
                notes: item.notes,
            },
            existing: 'reuse',
        });
        if (!prepared.ok) return {ok: false, reason: prepared.reason};
        const warnings = [
            ...(claimed.ok ? [] : [`Not assigned to you on GitHub: ${claimed.reason}.`]),
            ...(thread ? [] : ['Could not read its thread; the session starts from the title and your notes.']),
        ];
        return {
            ok: true,
            projectPath,
            worktreePath: prepared.worktreePath,
            branch: prepared.branch,
            prompt: prepared.prompt,
            ...(warnings.length ? {warning: warnings.join(' ')} : {}),
        };
    }

    /** The renderer started the session: the issue is in progress, on its branch. */
    public started(key: string, branch: string, sessionId: string | null): InboxItem | null {
        if (!this.issue(key)) return null;
        this.deps.inbox.startWork(key);
        return this.deps.inbox.setWork(key, {branch, sessionId, pullRequest: null});
    }

    // ── Stop working on it ──

    /** Back in the inbox, read; and off the issue on GitHub when asked. */
    public async stopWork(key: string, unassign: boolean): Promise<{item: InboxItem | null; warning?: string}> {
        const facts = this.issue(key);
        if (!facts) return {item: null};
        const item = this.deps.inbox.returnToInbox(key);
        if (!unassign) return {item};
        const unassigned = await this.deps.github.unassignSelf(facts.repository, facts.number);
        return unassigned.ok ? {item} : {item, warning: `Still assigned to you on GitHub: ${unassigned.reason}.`};
    }

    // ── Following ──

    /** Read the started issues' PRs once. One asked for while one runs is that one. */
    public follow(): Promise<void> {
        if (this.following) return this.following;
        this.following = this.followAll()
            .catch((err) => this.deps.log.error('[issue-manager] following failed:', (err as Error).message))
            .finally(() => {
                this.following = null;
            });
        return this.following;
    }

    private async followAll(): Promise<void> {
        const started = this.deps.inbox.list('issue').filter((item) => item.state.kind === 'inProgress');
        const repositories = new Set(started.map((item) => item.source));
        for (const repository of repositories) {
            const pullRequests = await this.deps.github.pullRequestsIn(repository, {merged: true});
            if (!pullRequests) {
                this.deps.log.warn(`[issue-manager] PRs of ${repository} not read`);
                continue;
            }
            for (const item of started) {
                if (item.source !== repository || item.facts.kind !== 'issue') continue;
                const found = issueWorkStage(pullRequests, item.facts);
                if (!found) continue;
                const work = item.work ?? {branch: '', sessionId: null, pullRequest: null};
                if (work.pullRequest !== found.pullRequest) {
                    this.deps.inbox.setWork(item.key, {...work, pullRequest: found.pullRequest});
                }
                if (found.stage === 'merged') this.deps.inbox.finish(item.key);
                else this.deps.inbox.setStage(item.key, found.stage);
            }
        }
    }

    private issue(key: string): IssueFacts | null {
        const item = this.deps.inbox.item(key);
        return item?.facts.kind === 'issue' ? item.facts : null;
    }
}
