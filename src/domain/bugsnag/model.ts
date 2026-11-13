/**
 * Bugsnag as the Bug manager sees it (#411, for #409): projects, errors, the
 * per-day trend of an error and the events since a time, and how Bugsnag's
 * Data Access API (`X-Version: 2`) answers them.
 *
 * The parsers take the decoded JSON as `unknown` and keep only what Switchboard
 * reads, so a field Bugsnag adds or drops never reaches past here, and a body
 * of the wrong shape comes back as nothing rather than a throw.
 */

/** A Bugsnag project the token can see. */
export interface BugsnagProject {
    id: string;
    name: string;
    slug: string;
    /** The project on the Bugsnag dashboard; null when the API did not say. */
    htmlUrl: string | null;
}

/** An error (a group of events) in a Bugsnag project. */
export interface BugsnagError {
    id: string;
    projectId: string;
    errorClass: string;
    message: string;
    context: string;
    severity: string;
    /** `open`, `fixed`, `snoozed`, `ignored`, … as Bugsnag says. */
    status: string;
    /** Events in the window the list was filtered to. */
    events: number;
    /** Users in the window the list was filtered to. */
    users: number;
    /** ISO: first and last seen in the filtered window. */
    firstSeen: string;
    lastSeen: string;
    /** ISO: first seen at all, unfiltered; what "new" is judged on. */
    firstSeenUnfiltered: string;
    releaseStages: string[];
    /** Issue or PR URLs linked on the error. */
    linkedIssues: string[];
}

/** One bucket of an error's trend: the events between `from` and `to` (ISO). */
export interface TrendBucket {
    from: string;
    to: string;
    events: number;
}

/** One occurrence of an error, as far as the "seen again" judgement needs it. */
export interface BugsnagEvent {
    id: string;
    /** ISO. */
    receivedAt: string;
    /** The app version that sent it; null when the app did not report one. */
    appVersion: string | null;
    releaseStage: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function text(value: unknown, fallback = ''): string {
    return typeof value === 'string' ? value : fallback;
}

function count(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** The array a list endpoint answers, or the `data` array the MCP's wrapper has. */
function list(body: unknown): unknown[] {
    if (Array.isArray(body)) return body;
    const data = record(body)?.data;
    return Array.isArray(data) ? data : [];
}

/** Organizations as `GET /user/organizations` answers them: only the ids matter. */
export function parseOrganizationIds(body: unknown): string[] {
    return list(body)
        .map((org) => text(record(org)?.id))
        .filter((id) => id !== '');
}

/** Projects as `GET /organizations/:id/projects` answers them. */
export function parseProjects(body: unknown): BugsnagProject[] {
    const projects: BugsnagProject[] = [];
    for (const item of list(body)) {
        const project = record(item);
        const id = text(project?.id);
        if (!project || !id) continue;
        projects.push({
            id,
            name: text(project.name, id),
            slug: text(project.slug),
            htmlUrl: typeof project.html_url === 'string' ? project.html_url : null,
        });
    }
    return projects;
}

/** Errors as `GET /projects/:id/errors` answers them. */
export function parseErrors(body: unknown): BugsnagError[] {
    const errors: BugsnagError[] = [];
    for (const item of list(body)) {
        const error = record(item);
        const id = text(error?.id);
        if (!error || !id) continue;
        const firstSeen = text(error.first_seen);
        errors.push({
            id,
            projectId: text(error.project_id),
            errorClass: text(error.error_class),
            message: text(error.message),
            context: text(error.context),
            severity: text(error.severity),
            status: text(error.status),
            events: count(error.events),
            users: count(error.users),
            firstSeen,
            lastSeen: text(error.last_seen),
            firstSeenUnfiltered: text(error.first_seen_unfiltered, firstSeen),
            releaseStages: Array.isArray(error.release_stages)
                ? error.release_stages.filter((stage): stage is string => typeof stage === 'string')
                : [],
            linkedIssues: linkedIssueUrls(error),
        });
    }
    return errors;
}

function linkedIssueUrls(error: Record<string, unknown>): string[] {
    const urls = new Set<string>();
    const linked = Array.isArray(error.linked_issues) ? error.linked_issues : [];
    for (const issue of [...linked, error.created_issue]) {
        const url = text(record(issue)?.url);
        if (url) urls.add(url);
    }
    return [...urls];
}

/** Trend buckets as `GET /projects/:id/errors/:id/trend` answers them, oldest first. */
export function parseTrend(body: unknown): TrendBucket[] {
    const buckets: TrendBucket[] = [];
    for (const item of list(body)) {
        const bucket = record(item);
        if (!bucket) continue;
        const from = text(bucket.from);
        if (!from) continue;
        buckets.push({from, to: text(bucket.to), events: count(bucket.events_count ?? bucket.count)});
    }
    return buckets.sort((a, b) => Date.parse(a.from) - Date.parse(b.from));
}

/**
 * Events as `GET /projects/:id/errors/:id/events` answers them. A full report
 * keeps the notifier's own camelCase (`app.version`, `app.releaseStage`); a
 * summary may carry `app_version` and `release_stage`. An app that reports no
 * version gives null.
 */
export function parseEvents(body: unknown): BugsnagEvent[] {
    const events: BugsnagEvent[] = [];
    for (const item of list(body)) {
        const event = record(item);
        const id = text(event?.id);
        if (!event || !id) continue;
        const app = record(event.app);
        const version = app?.version ?? event.app_version;
        const stage = app?.releaseStage ?? app?.release_stage ?? event.release_stage;
        events.push({
            id,
            receivedAt: text(event.received_at),
            appVersion: typeof version === 'string' && version !== '' ? version : null,
            releaseStage: typeof stage === 'string' && stage !== '' ? stage : null,
        });
    }
    return events;
}

/**
 * The next page's URL from a `Link` header (`<url>; rel="next"`), made absolute
 * against `base`; null on the last page.
 */
export function nextPageUrl(link: string | null, base: string): string | null {
    if (!link) return null;
    for (const part of link.split(',')) {
        const match = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
        if (match) return new URL(match[1], base).toString();
    }
    return null;
}
