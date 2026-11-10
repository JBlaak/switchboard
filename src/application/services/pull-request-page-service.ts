/**
 * Pull requests no session opened: the peek a PR link shows, and the work
 * page of its own the peek opens on request.
 *
 * Such a PR has no checkout and no session behind it, so everything here comes
 * from GitHub: its status and threads from `gh`, its diff from `gh pr diff`.
 * The page is keyed by a page id that is never a session's
 * (`pullRequestPageId`), carries the one PR as its only item, and is asked
 * `gh` again every minute while it is open, like a session's page.
 *
 * It hands nothing to Claude: its item is marked as in another repository,
 * which is what turns every action off, and your review can be submitted or
 * discarded but never handed over to fix. Only one such page is open at a time.
 */
import {parseUnifiedDiff} from '../../domain/session-work/diff';
import {workItemKey} from '../../domain/session-work/items';
import {
    pullRequestPageId,
    pullRequestPageRef,
    pullRequestUrl,
    type PullRequestPeek,
    type PullRequestRef,
} from '../../domain/session-work/pull-request-link';
import type {
    FileDiff,
    GitHubAvailability,
    PullRequestStatus,
    SessionWorkDiff,
    SessionWorkItem,
    SessionWorkSnapshot,
} from '../../domain/session-work/model';
import type {ActionContext} from './session-action-service';
import {GITHUB_REFRESH_MS} from './session-work-service';
import type {Clock, TimerHandle, Timers} from '../ports/clock';
import type {GitHubCli} from '../ports/github-cli';
import type {Logger} from '../ports/logger';
import type {RendererGateway} from '../ports/renderer-gateway';

export interface PullRequestPageServiceDeps {
    /** Reads only: your review is the review service's. */
    github: Pick<GitHubCli, 'available' | 'pullRequests' | 'pullRequestDiff'>;
    renderer: Pick<RendererGateway, 'sessionWorkSnapshot'>;
    clock: Clock;
    timers: Timers;
    log: Logger;
}

/** The one open page. */
interface Page {
    readonly pageId: string;
    readonly ref: PullRequestRef;
    gh: GitHubAvailability;
    item: SessionWorkItem;
    poll: TimerHandle | null;
    building: Promise<void> | null;
    again: boolean;
    /** Why the diff could not be had, until it can. */
    diffError: string | null;
    /** GitHub's diff, parsed, by the head commit it was fetched at. */
    readonly diffCache: Map<string, FileDiff[]>;
    last: SessionWorkSnapshot | null;
    lastKey: string;
    closed: boolean;
}

const NO_DIFF: SessionWorkDiff = {files: [], source: null};

export class PullRequestPageService {
    private page: Page | null = null;

    constructor(private readonly deps: PullRequestPageServiceDeps) {}

    /**
     * What the peek shows: the PR's status and its diff from GitHub. Never
     * rejects; when there is no diff, `error` says why.
     */
    public async peek(ref: PullRequestRef): Promise<PullRequestPeek> {
        const valid = validRef(ref);
        if (!valid) {
            return {
                ref: {repository: String(ref?.repository ?? ''), number: Number(ref?.number)},
                url: '',
                pr: null,
                files: [],
                error: 'That is not a pull request link',
            };
        }
        const url = pullRequestUrl(valid);
        const failed = (error: string, pr: PullRequestStatus | null = null): PullRequestPeek => ({
            ref: valid,
            url,
            pr,
            files: [],
            error,
        });
        try {
            const gh = await this.deps.github.available();
            if (gh !== 'ok') return failed(unavailableReason(gh));
            const [statuses, text] = await Promise.all([
                this.deps.github.pullRequests(valid.repository, [valid.number]),
                this.deps.github.pullRequestDiff(valid.repository, valid.number),
            ]);
            const pr = statuses?.find((status) => status.number === valid.number) ?? null;
            if (text === null) {
                return failed(
                    pr ? 'GitHub did not send the diff' : 'GitHub does not know this PR, or could not be asked',
                    pr,
                );
            }
            return {ref: valid, url, pr, files: parseUnifiedDiff(text)};
        } catch (err) {
            this.deps.log.warn('[pull-request] peek failed:', (err as Error).message);
            return failed((err as Error).message || 'GitHub could not be asked');
        }
    }

    /** Whether a page id is a PR's own page that can open. */
    public canOpen(pageId: string): boolean {
        return pullRequestPageRef(pageId) !== null;
    }

    /**
     * Open the PR's page: ask `gh` about it and poll every minute. Closes
     * whichever PR page was open. Answers the first snapshot, or null for a
     * page id that is not a PR's.
     */
    public async open(pageId: string): Promise<SessionWorkSnapshot | null> {
        const ref = pullRequestPageRef(pageId);
        if (!ref) return null;
        const current = this.page;
        if (current && current.pageId === pageId) {
            await this.refresh(current);
            return current.closed ? null : current.last;
        }
        if (current) this.dispose(current);

        const page: Page = {
            pageId,
            ref,
            gh: 'missing',
            item: bareItem(ref),
            poll: null,
            building: null,
            again: false,
            diffError: null,
            diffCache: new Map(),
            last: null,
            lastKey: '',
            closed: false,
        };
        this.page = page;
        page.poll = this.deps.timers.setInterval(() => void this.refresh(page), GITHUB_REFRESH_MS);
        await this.refresh(page);
        return page.closed ? null : page.last;
    }

    /** Close the page and stop polling. A close for a page that is not open is ignored. */
    public close(pageId: string): void {
        if (this.page && this.page.pageId === pageId) this.dispose(this.page);
    }

    /** Close whatever PR page is open, for shutdown. */
    public closeAll(): void {
        if (this.page) this.dispose(this.page);
    }

    /** The PR page that is open, if any. */
    public get openPageId(): string | null {
        return this.page?.pageId ?? null;
    }

    /** The page's item, as last built; null when the page is not open or the id is not its item's. */
    public item(pageId: string, itemId: string): SessionWorkItem | null {
        const page = this.page;
        if (!page || page.pageId !== pageId || !page.last || page.item.id !== itemId) return null;
        return page.item;
    }

    /** What your review needs to know about the open page: there is no checkout. */
    public context(pageId: string): ActionContext | null {
        const page = this.page;
        if (!page || page.pageId !== pageId || !page.last) return null;
        return {repository: page.ref.repository, mainCheckout: '', gh: page.gh};
    }

    /** Ask `gh` again now, after your review was written, and push the snapshot. */
    public async refreshGitHub(pageId: string): Promise<void> {
        const page = this.page;
        if (!page || page.pageId !== pageId || page.closed) return;
        await this.refresh(page);
    }

    /** GitHub's diff of the page's PR, cached by its head commit. */
    public async diff(pageId: string, itemId: string): Promise<SessionWorkDiff> {
        const page = this.page;
        if (!page || page.pageId !== pageId || page.item.id !== itemId) return NO_DIFF;

        let result: SessionWorkDiff;
        try {
            result = await this.diffOf(page);
        } catch (err) {
            result = {files: [], source: null, error: (err as Error).message || 'The diff could not be read'};
        }
        if (page.closed) return result;
        const before = page.diffError;
        page.diffError = result.error ?? null;
        if (before !== page.diffError) this.publish(page);
        return result;
    }

    /** A PR page has no checkout to read an image's sides from. */
    public async image(): Promise<Uint8Array | null> {
        return null;
    }

    private async diffOf(page: Page): Promise<SessionWorkDiff> {
        const failed = (error: string): SessionWorkDiff => ({files: [], source: null, error});
        if (page.gh !== 'ok') return failed(unavailableReason(page.gh));
        if (page.item.kind !== 'pr') return NO_DIFF;
        const {repository, number} = page.ref;
        const headSha = page.item.pr.headSha;
        const cached = headSha ? page.diffCache.get(headSha) : undefined;
        if (cached) return {files: cached, source: 'github'};
        const text = await this.deps.github.pullRequestDiff(repository, number);
        if (text === null) return failed('GitHub did not send the diff');
        // No checkout to read `.gitattributes` in: lockfiles, build output and huge files still start collapsed.
        const files = parseUnifiedDiff(text);
        if (headSha && !page.closed) page.diffCache.set(headSha, files);
        return {files, source: 'github'};
    }

    /** Ask `gh` again, one build at a time: a request during a build runs one more after it. */
    private refresh(page: Page): Promise<void> {
        if (page.building) {
            page.again = true;
            return page.building;
        }
        page.building = (async () => {
            do {
                page.again = false;
                try {
                    await this.build(page);
                } catch (err) {
                    this.deps.log.error('[pull-request] building the page failed:', (err as Error).message);
                }
            } while (page.again && !page.closed);
        })().finally(() => {
            page.building = null;
        });
        return page.building;
    }

    private async build(page: Page): Promise<void> {
        const {github} = this.deps;
        const gh = await github.available();
        if (page.closed) return;
        let item: SessionWorkItem;
        if (gh !== 'ok') {
            item = {...bareItem(page.ref), error: unavailableReason(gh)};
        } else {
            const statuses = await github.pullRequests(page.ref.repository, [page.ref.number]);
            if (page.closed) return;
            const pr = statuses?.find((status) => status.number === page.ref.number);
            item = pr
                ? pullRequestItem(page.ref, pr)
                : {
                      ...bareItem(page.ref),
                      error: statuses === null ? 'GitHub did not answer for this PR' : 'GitHub does not know this PR',
                  };
        }
        page.gh = gh;
        page.item = item;
        this.publish(page);
    }

    /** Push the snapshot when it differs from the last one pushed. */
    private publish(page: Page): void {
        const error = page.diffError ?? page.item.error;
        const item: SessionWorkItem = error ? {...page.item, error} : page.item;
        const items = [item];
        const footprint = {worktrees: 0, branches: 0};
        const key = JSON.stringify({gh: page.gh, items});
        if (key === page.lastKey && page.last) return;
        page.lastKey = key;
        page.last = {
            sessionId: page.pageId,
            repository: page.ref.repository,
            items,
            footprint,
            queued: 0,
            gh: page.gh,
            updatedAt: new Date(this.deps.clock.now()).toISOString(),
        };
        this.deps.renderer.sessionWorkSnapshot(page.last);
    }

    private dispose(page: Page): void {
        page.closed = true;
        this.deps.timers.clearInterval(page.poll);
        page.poll = null;
        if (this.page === page) this.page = null;
    }
}

/** The ref as a valid PR, or null: what the renderer sent is checked, not trusted. */
function validRef(ref: PullRequestRef | null | undefined): PullRequestRef | null {
    if (!ref || typeof ref.repository !== 'string' || typeof ref.number !== 'number') return null;
    return pullRequestPageRef(pullRequestPageId(ref));
}

/** The page's one item: the PR, in no checkout, handing nothing to Claude. */
function pullRequestItem(ref: PullRequestRef, pr: PullRequestStatus): SessionWorkItem {
    const item = {
        kind: 'pr' as const,
        pr,
        location: null,
        diff: {kind: 'pull-request' as const, repository: ref.repository, number: ref.number},
        activity: null,
        otherRepository: true as const,
    };
    return {...item, id: workItemKey(item)};
}

/** The PR as far as its link says, for when `gh` says nothing about it. */
function bareItem(ref: PullRequestRef): SessionWorkItem {
    return pullRequestItem(ref, {
        number: ref.number,
        url: pullRequestUrl(ref),
        repository: ref.repository,
        closes: [],
    });
}

function unavailableReason(gh: GitHubAvailability): string {
    return gh === 'missing'
        ? 'gh is not installed, so the PR cannot be fetched from GitHub'
        : 'gh is not signed in to GitHub, so the PR cannot be fetched';
}
