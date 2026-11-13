/**
 * Bugsnag's Data Access API as a dependency (#411, for #409): what the Bug
 * manager reads and the two things it writes (`fix` at merge, `link_issue`
 * from a Fix session's PR). One instance speaks for one personal auth token;
 * `BugsnagApiFactory` makes one for a token, so a token can be tried before
 * it is saved.
 *
 * Every call rejects with a `BugsnagApiError` when Bugsnag can't be asked or
 * says no, so the caller can tell a wrong token from a dropped connection.
 */
import type {
    BugsnagError,
    BugsnagEvent,
    BugsnagEventDetail,
    BugsnagProject,
    TrendBucket,
} from '../../domain/bugsnag/model';
import type {BugsnagFailure} from '../../domain/bugsnag/connection';

/** What to list: Bugsnag's filters, sort and paging. Absent filters aren't sent. */
export interface ErrorQuery {
    /** `open` by default. */
    status?: string;
    /** Only errors with events since this time. */
    since?: Date;
    releaseStage?: string;
    severity?: string;
    sort?: 'first_seen' | 'last_seen' | 'events' | 'users' | 'unsorted';
    direction?: 'asc' | 'desc';
    /** Up to 100; 30 by default. */
    perPage?: number;
    /** The `next` of a previous page; the other fields are then ignored. */
    page?: string;
}

export interface ErrorPage {
    errors: BugsnagError[];
    /** Pass as `page` for the next page; null on the last. */
    next: string | null;
    /** How many errors match in all, when Bugsnag said. */
    total: number | null;
}

export interface BugsnagApi {
    /** Every project the token sees, across its organizations. */
    listProjects(): Promise<BugsnagProject[]>;
    /** One page of a project's errors. */
    listErrors(projectId: string, query?: ErrorQuery): Promise<ErrorPage>;
    /** An error's events per 24 h for the last `days` days, oldest first; the last bucket ends now. */
    errorTrend(projectId: string, errorId: string, days: number): Promise<TrendBucket[]>;
    /** An error's events received since `since`, newest first, with their app version. */
    eventsSince(projectId: string, errorId: string, since: Date): Promise<BugsnagEvent[]>;
    /**
     * An error's newest event (`'latest'`) or its oldest (`'first'`), with its
     * stack trace; null when it has none.
     */
    eventDetail(projectId: string, errorId: string, which: 'latest' | 'first'): Promise<BugsnagEventDetail | null>;
    /** Mark an error fixed. */
    fix(projectId: string, errorId: string): Promise<void>;
    /** Link an issue or pull request URL on an error. */
    linkIssue(projectId: string, errorId: string, url: string): Promise<void>;
}

/** Makes the API for one token. */
export type BugsnagApiFactory = (token: string) => BugsnagApi;

/** Why a Bugsnag call failed. Its message never carries the token. */
export class BugsnagApiError extends Error {
    constructor(
        public readonly failure: BugsnagFailure,
        message: string,
        public readonly status: number | null = null,
    ) {
        super(message);
        this.name = 'BugsnagApiError';
    }
}
