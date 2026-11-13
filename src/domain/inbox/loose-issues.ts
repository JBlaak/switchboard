/**
 * Which of a watched repository's issues the Issue manager lists (#413, #409
 * story 13): loose ones, by the project page's own rule (`groupOverview`: no
 * parent, no sub-issues, not in a plan), that are unassigned or assigned to
 * you. The ones you opened yourself are listed like any other.
 *
 * A parent in another repository still makes an issue part of a plan, so
 * unlike the project page's grouping it is not loose here. A standalone
 * `ready-for-agent` issue is a plan of its own and is left out too.
 */
import {groupOverview, type OverviewIssue} from '../plan/project-overview';
import {STANDALONE_PLAN_LABEL, type IssueKey} from '../plan/model';
import type {IssueFacts} from './model';

/** An open issue as the Issue manager's read answers it: the facts, and what places it in a plan. */
export interface InboxIssueRead extends IssueFacts {
    readonly parent: IssueKey | null;
    readonly subIssues: number;
}

/** What one read of a repository answered. */
export interface InboxIssuesAnswer {
    /** The user `gh` signs in as; null when GitHub did not say. */
    readonly viewer: string | null;
    readonly issues: readonly InboxIssueRead[];
    /** Every open issue was read: one left out has closed (or is no longer open). */
    readonly complete: boolean;
}

/** Unassigned, or assigned to `viewer`. Without a viewer, unassigned only. */
export function assignableTo(issue: Pick<IssueFacts, 'assignees'>, viewer: string | null): boolean {
    return issue.assignees.length === 0 || (viewer !== null && issue.assignees.includes(viewer));
}

/** The issues the Issue manager lists, as facts, in `groupOverview`'s loose order (newest update first). */
export function looseIssues(repository: string, answer: InboxIssuesAnswer): IssueFacts[] {
    const byNumber = new Map(answer.issues.map((issue) => [issue.number, issue]));
    const overview: (OverviewIssue & {read: InboxIssueRead})[] = answer.issues.map((issue) => ({
        number: issue.number,
        title: issue.title,
        updatedAt: issue.updatedAt,
        parent: issue.parent ? issue.parent.number : null,
        subIssueCount: issue.subIssues,
        read: issue,
    }));
    const {loose} = groupOverview({
        repository,
        plans: [],
        issues: overview,
        pullRequests: [],
        sessions: {owners: {}, running: new Set()},
    });
    return loose
        .map((row) => byNumber.get(row.issue.number)!)
        .filter((issue) => !issue.labels.some((label) => label.name === STANDALONE_PLAN_LABEL))
        .filter((issue) => assignableTo(issue, answer.viewer))
        .map(toFacts);
}

function toFacts(issue: InboxIssueRead): IssueFacts {
    return {
        kind: 'issue',
        repository: issue.repository,
        number: issue.number,
        title: issue.title,
        url: issue.url,
        author: issue.author,
        assignees: issue.assignees,
        labels: issue.labels,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
        comments: issue.comments,
        lastCommentBy: issue.lastCommentBy,
        references: issue.references,
    };
}
