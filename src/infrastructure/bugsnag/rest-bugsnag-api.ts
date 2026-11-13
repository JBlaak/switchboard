/**
 * Bugsnag's Data Access API over REST, behind the BugsnagApi port (#411).
 *
 * Asked with the user's personal auth token (`Authorization: token …`,
 * `X-Version: 2`), not through the bugsnag MCP, whose OAuth credentials
 * Switchboard can't reach. The token goes in that header and nowhere else:
 * not in a URL, an error message or a log line.
 *
 * Rate limits: a 429 waits for its `Retry-After` (capped), or 1 s, 2 s, 4 s
 * when it gives none, and tries again up to three times before giving up as
 * `rate-limited`.
 */
import {
    nextPageUrl,
    parseErrors,
    parseEvents,
    parseOrganizationIds,
    parseProjects,
    parseTrend,
} from '../../domain/bugsnag/model';
import {BugsnagApiError} from '../../application/ports/bugsnag-api';
import type {BugsnagEvent, BugsnagProject, TrendBucket} from '../../domain/bugsnag/model';
import type {BugsnagApi, ErrorPage, ErrorQuery} from '../../application/ports/bugsnag-api';
import type {Logger} from '../../application/ports/logger';

export const BUGSNAG_API_BASE = 'https://api.bugsnag.com';

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;
const MAX_RETRY_AFTER_MS = 60_000;
/** Pages followed at most for one list, so a runaway `Link` chain can't loop. */
const MAX_PAGES = 20;

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface RestBugsnagApiOptions {
    token: string;
    log: Logger;
    fetch?: Fetch;
    /** Waits between 429 retries; a real timer by default. */
    sleep?: (ms: number) => Promise<void>;
    base?: string;
}

interface Answer {
    body: unknown;
    headers: Headers;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class RestBugsnagApi implements BugsnagApi {
    private readonly token: string;
    private readonly log: Logger;
    private readonly fetch: Fetch;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly base: string;

    constructor(options: RestBugsnagApiOptions) {
        this.token = options.token.trim();
        this.log = options.log;
        this.fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
        this.sleep = options.sleep ?? realSleep;
        this.base = options.base ?? BUGSNAG_API_BASE;
    }

    public async listProjects(): Promise<BugsnagProject[]> {
        const orgs = await this.allPages(this.url('/user/organizations', {per_page: '100'}), parseOrganizationIds);
        const projects: BugsnagProject[] = [];
        const seen = new Set<string>();
        for (const org of orgs) {
            const url = this.url(`/organizations/${encodeURIComponent(org)}/projects`, {per_page: '100'});
            for (const project of await this.allPages(url, parseProjects)) {
                if (seen.has(project.id)) continue;
                seen.add(project.id);
                projects.push(project);
            }
        }
        return projects;
    }

    public async listErrors(projectId: string, query: ErrorQuery = {}): Promise<ErrorPage> {
        const url = query.page ? this.ownUrl(query.page) : this.errorsUrl(projectId, query);
        const answer = await this.request('GET', url);
        const total = Number(answer.headers.get('x-total-count'));
        return {
            errors: parseErrors(answer.body),
            next: nextPageUrl(answer.headers.get('link'), this.base),
            total: answer.headers.has('x-total-count') && Number.isFinite(total) ? total : null,
        };
    }

    public async errorTrend(projectId: string, errorId: string, days: number): Promise<TrendBucket[]> {
        // `days` buckets over a `days`-day window: rolling 24 h buckets ending now,
        // so the last one is the last 24 h. (`resolution` takes only fixed values
        // such as `12h` and counts from the error's first event.)
        const url = this.url(`${this.errorPath(projectId, errorId)}/trend`, {
            buckets_count: String(days),
            ...filter('event.since', `${days}d`),
        });
        return parseTrend((await this.request('GET', url)).body);
    }

    public async eventsSince(projectId: string, errorId: string, since: Date): Promise<BugsnagEvent[]> {
        const url = this.url(`${this.errorPath(projectId, errorId)}/events`, {
            full_reports: 'true',
            per_page: '100',
            direction: 'desc',
            ...filter('event.since', since.toISOString()),
        });
        return this.allPages(url, parseEvents);
    }

    public async fix(projectId: string, errorId: string): Promise<void> {
        await this.request('PATCH', this.url(this.errorPath(projectId, errorId)), {operation: 'fix'});
    }

    public async linkIssue(projectId: string, errorId: string, url: string): Promise<void> {
        await this.request('PATCH', this.url(this.errorPath(projectId, errorId)), {
            operation: 'link_issue',
            issue_url: url,
        });
    }

    private errorPath(projectId: string, errorId: string): string {
        return `/projects/${encodeURIComponent(projectId)}/errors/${encodeURIComponent(errorId)}`;
    }

    private errorsUrl(projectId: string, query: ErrorQuery): string {
        return this.url(`/projects/${encodeURIComponent(projectId)}/errors`, {
            sort: query.sort ?? 'last_seen',
            direction: query.direction ?? 'desc',
            per_page: String(Math.min(100, Math.max(1, query.perPage ?? 30))),
            ...filter('error.status', query.status ?? 'open'),
            ...(query.since ? filter('event.since', query.since.toISOString()) : {}),
            ...(query.releaseStage ? filter('app.release_stage', query.releaseStage) : {}),
            ...(query.severity ? filter('event.severity', query.severity) : {}),
        });
    }

    private url(path: string, params: Record<string, string> = {}): string {
        const url = new URL(path, this.base);
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
        return url.toString();
    }

    /** A page URL handed back by a caller: only ever sent to Bugsnag's own host, with the token. */
    private ownUrl(page: string): string {
        const url = new URL(page, this.base);
        if (url.origin !== new URL(this.base).origin) {
            throw new BugsnagApiError('unexpected', 'That page is not on Bugsnag.');
        }
        return url.toString();
    }

    private async allPages<T>(first: string, parse: (body: unknown) => T[]): Promise<T[]> {
        const items: T[] = [];
        let url: string | null = first;
        for (let page = 0; url && page < MAX_PAGES; page++) {
            const answer: Answer = await this.request('GET', url);
            items.push(...parse(answer.body));
            url = nextPageUrl(answer.headers.get('link'), this.base);
            if (url) url = this.ownUrl(url);
        }
        return items;
    }

    private async request(method: string, url: string, json?: unknown): Promise<Answer> {
        for (let attempt = 0; ; attempt++) {
            const res = await this.send(method, url, json);
            if (res.status === 429 && attempt < MAX_RETRIES) {
                const wait = retryAfterMs(res.headers.get('retry-after'), attempt);
                this.log.warn(`[bugsnag] rate limited, retrying in ${Math.round(wait / 1000)} s`);
                await this.sleep(wait);
                continue;
            }
            if (!res.ok) throw failureFor(res.status);
            const body = res.status === 204 ? null : await readJson(res);
            return {body, headers: res.headers};
        }
    }

    private async send(method: string, url: string, json?: unknown): Promise<Response> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            return await this.fetch(url, {
                method,
                signal: controller.signal,
                headers: {
                    Authorization: `token ${this.token}`,
                    'X-Version': '2',
                    Accept: 'application/json',
                    ...(json !== undefined ? {'Content-Type': 'application/json'} : {}),
                },
                ...(json !== undefined ? {body: JSON.stringify(json)} : {}),
            });
        } catch (err) {
            this.log.warn(`[bugsnag] ${method} ${new URL(url).pathname} failed:`, (err as Error).message);
            throw new BugsnagApiError('unreachable', "Couldn't reach Bugsnag.");
        } finally {
            clearTimeout(timer);
        }
    }
}

/** One Bugsnag filter as query parameters: `filters[field][][type]=eq&filters[field][][value]=…`. */
function filter(field: string, value: string): Record<string, string> {
    return {[`filters[${field}][][type]`]: 'eq', [`filters[${field}][][value]`]: value};
}

/** How long a 429 asks to wait: its `Retry-After` seconds (capped), else 1 s, 2 s, 4 s. */
export function retryAfterMs(header: string | null, attempt: number): number {
    const seconds = Number(header);
    if (header !== null && header.trim() !== '' && Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(MAX_RETRY_AFTER_MS, seconds * 1000);
    }
    return 1000 * 2 ** attempt;
}

function failureFor(status: number): BugsnagApiError {
    if (status === 401) return new BugsnagApiError('unauthorized', 'Bugsnag did not accept the token.', status);
    if (status === 403) return new BugsnagApiError('forbidden', 'The token is not allowed to do that.', status);
    if (status === 429) return new BugsnagApiError('rate-limited', 'Bugsnag is limiting requests.', status);
    return new BugsnagApiError('unexpected', `Bugsnag answered ${status}.`, status);
}

async function readJson(res: Response): Promise<unknown> {
    const body = await res.text();
    if (body.trim() === '') return null;
    try {
        return JSON.parse(body) as unknown;
    } catch {
        throw new BugsnagApiError('unexpected', 'Bugsnag answered something that is not JSON.', res.status);
    }
}
