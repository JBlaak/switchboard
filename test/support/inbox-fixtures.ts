/**
 * Bugs and issues for the inbox tests (#413), each a set of defaults with
 * whatever the test cares about laid over them.
 */
import type {BugFacts, IssueFacts} from '../../src/domain/inbox/model';
import type {InboxIssueRead} from '../../src/domain/inbox/loose-issues';
import type {BugsnagError} from '../../src/domain/bugsnag/model';
import type {TrendingThresholds} from '../../src/domain/bugsnag/connection';

/** Fri 13 Nov 2026, 12:00 UTC. */
export const NOW = Date.parse('2026-11-13T12:00:00Z');
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const THRESHOLDS: TrendingThresholds = {multiplier: 3, minEvents: 20};

export const PROJECT = 'connect-api';
export const REPO = 'movelab/connect';
export const ME = 'joris';

export function bug(errorId: string, overrides: Partial<BugFacts> = {}): BugFacts {
    return {
        kind: 'bug',
        projectId: PROJECT,
        errorId,
        errorClass: 'TypeError',
        message: `Cannot read properties of undefined (${errorId})`,
        context: 'ExportDialog',
        severity: 'error',
        status: 'open',
        releaseStages: ['production'],
        firstSeen: new Date(NOW - 30 * DAY).toISOString(),
        lastSeen: new Date(NOW - HOUR).toISOString(),
        events: 120,
        users: 14,
        events24h: 2,
        events7d: 14,
        linkedIssues: [],
        ...overrides,
    };
}

export function issue(number: number, overrides: Partial<IssueFacts> = {}): IssueFacts {
    return {
        kind: 'issue',
        repository: REPO,
        number,
        title: `Ticket ${number}`,
        url: `https://github.com/${REPO}/issues/${number}`,
        author: 'colleague',
        assignees: [],
        labels: [],
        createdAt: new Date(NOW - 10 * DAY).toISOString(),
        updatedAt: new Date(NOW - DAY).toISOString(),
        comments: 1,
        lastCommentBy: 'colleague',
        references: 0,
        ...overrides,
    };
}

export function issueRead(number: number, overrides: Partial<InboxIssueRead> = {}): InboxIssueRead {
    return {...issue(number), parent: null, subIssues: 0, ...overrides};
}

export function bugsnagError(id: string, overrides: Partial<BugsnagError> = {}): BugsnagError {
    return {
        id,
        projectId: PROJECT,
        errorClass: 'TypeError',
        message: `Cannot read properties of undefined (${id})`,
        context: 'ExportDialog',
        severity: 'error',
        status: 'open',
        events: 120,
        users: 14,
        firstSeen: new Date(NOW - 30 * DAY).toISOString(),
        lastSeen: new Date(NOW - HOUR).toISOString(),
        firstSeenUnfiltered: new Date(NOW - 30 * DAY).toISOString(),
        releaseStages: ['production'],
        linkedIssues: [],
        ...overrides,
    };
}
