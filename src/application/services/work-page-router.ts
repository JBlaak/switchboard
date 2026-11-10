/**
 * The Session work page, whoever's it is: a session's (`SessionWorkService`)
 * or a pull request's own, for a PR no session opened
 * (`PullRequestPageService`, page ids from `pullRequestPageId`). The IPC and
 * your review go through here and never have to tell the two apart.
 *
 * One page is open at a time (D4): opening either kind closes the other.
 */
import {isPullRequestPageId} from '../../domain/session-work/pull-request-link';
import type {SessionWorkDiff, SessionWorkItem, SessionWorkSnapshot} from '../../domain/session-work/model';
import type {ActionContext} from './session-action-service';

/** What a page's back end answers, the same for both kinds. */
export interface WorkPageBackend {
    open(pageId: string): Promise<SessionWorkSnapshot | null>;
    canOpen(pageId: string): Promise<boolean> | boolean;
    close(pageId: string): void;
    closeAll(): void;
    diff(pageId: string, itemId: string): Promise<SessionWorkDiff>;
    image(pageId: string, itemId: string, path: string, side: 'before' | 'after'): Promise<Uint8Array | null>;
    item(pageId: string, itemId: string): SessionWorkItem | null;
    context(pageId: string): ActionContext | null;
    refreshGitHub(pageId: string): Promise<void>;
}

export class WorkPageRouter {
    constructor(
        private readonly sessions: WorkPageBackend,
        private readonly pullRequests: WorkPageBackend,
    ) {}

    /** Open a page, closing the other kind's. */
    public open(pageId: string): Promise<SessionWorkSnapshot | null> {
        this.other(pageId).closeAll();
        return this.backend(pageId).open(pageId);
    }

    public async canOpen(pageId: string): Promise<boolean> {
        return this.backend(pageId).canOpen(pageId);
    }

    public close(pageId: string): void {
        this.backend(pageId).close(pageId);
    }

    /** Close whatever page is open, of either kind, for shutdown. */
    public closeAll(): void {
        this.sessions.closeAll();
        this.pullRequests.closeAll();
    }

    public diff(pageId: string, itemId: string): Promise<SessionWorkDiff> {
        return this.backend(pageId).diff(pageId, itemId);
    }

    public image(pageId: string, itemId: string, path: string, side: 'before' | 'after'): Promise<Uint8Array | null> {
        return this.backend(pageId).image(pageId, itemId, path, side);
    }

    public item(pageId: string, itemId: string): SessionWorkItem | null {
        return this.backend(pageId).item(pageId, itemId);
    }

    public context(pageId: string): ActionContext | null {
        return this.backend(pageId).context(pageId);
    }

    public refreshGitHub(pageId: string): Promise<void> {
        return this.backend(pageId).refreshGitHub(pageId);
    }

    private backend(pageId: string): WorkPageBackend {
        return isPullRequestPageId(String(pageId)) ? this.pullRequests : this.sessions;
    }

    private other(pageId: string): WorkPageBackend {
        return isPullRequestPageId(String(pageId)) ? this.sessions : this.pullRequests;
    }
}
