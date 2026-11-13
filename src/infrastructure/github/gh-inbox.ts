/**
 * The Issue manager's read of a watched repository (#413): the GraphQL
 * `GhCli` sends for its open issues, and how the answer maps onto the inbox's
 * issue reads.
 *
 * Besides what places an issue in a plan (its parent and sub-issues), each
 * issue brings what the inbox lists and wakes on: its author and assignees,
 * its comment count and who wrote the newest, and how many commits
 * referenced it. The viewer comes in the same request, for "assigned to me"
 * and for leaving your own comments out of the wake rule. Kept apart from
 * `gh-cli.ts`, like `gh-overview.ts`, so the mapping can be tested from
 * recorded responses.
 */
import type {IssueLabel} from '../../domain/project/overview';
import type {InboxIssueRead, InboxIssuesAnswer} from '../../domain/inbox/loose-issues';

/** Open issues read per repository: the 100 most recently updated, one page. */
export const INBOX_ISSUES_PER_REPOSITORY = 100;

export const INBOX_ISSUES_QUERY = `query($owner: String!, $name: String!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    issues(states: [OPEN], first: ${INBOX_ISSUES_PER_REPOSITORY}, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage }
      nodes {
        number title url createdAt updatedAt
        repository { nameWithOwner }
        author { login }
        assignees(first: 10) { nodes { login } }
        labels(first: 20) { nodes { name color } }
        parent { number repository { nameWithOwner } }
        subIssuesSummary { total }
        comments(last: 1) { totalCount nodes { author { login } } }
        timelineItems(itemTypes: [REFERENCED_EVENT]) { totalCount }
      }
    }
  }
}`;

/** The answer in `INBOX_ISSUES_QUERY`'s data; null when it holds no repository. */
export function toInboxIssues(data: any, repo: string): InboxIssuesAnswer | null {
    const connection = data?.repository?.issues;
    const nodes = connection?.nodes;
    if (!Array.isArray(nodes)) return null;
    const viewer = typeof data?.viewer?.login === 'string' && data.viewer.login ? data.viewer.login : null;
    const issues = nodes
        .filter((node: any) => node && typeof node.number === 'number')
        .map((node: any): InboxIssueRead => {
            const repository = nameOf(node, repo);
            const parent =
                node.parent && typeof node.parent.number === 'number'
                    ? {repository: nameOf(node.parent, repository), number: node.parent.number}
                    : null;
            const lastComment = Array.isArray(node.comments?.nodes) ? node.comments.nodes[0] : null;
            return {
                kind: 'issue',
                repository,
                number: node.number,
                title: text(node.title),
                url: text(node.url) || `https://github.com/${repository}/issues/${node.number}`,
                author: loginOf(node.author),
                assignees: (node.assignees?.nodes ?? []).map(loginOf).filter((login: string | null) => login !== null),
                labels: (node.labels?.nodes ?? []).filter((label: any) => typeof label?.name === 'string').map(toLabel),
                createdAt: text(node.createdAt),
                updatedAt: text(node.updatedAt),
                comments: count(node.comments?.totalCount),
                lastCommentBy: loginOf(lastComment?.author),
                references: count(node.timelineItems?.totalCount),
                parent,
                subIssues: count(node.subIssuesSummary?.total),
            };
        });
    return {viewer, issues, complete: connection.pageInfo?.hasNextPage === false};
}

function text(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function count(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function loginOf(user: any): string | null {
    return typeof user?.login === 'string' && user.login ? user.login : null;
}

function toLabel(label: any): IssueLabel {
    return {name: label.name, color: typeof label.color === 'string' ? label.color : ''};
}

function nameOf(node: any, fallback: string): string {
    const name = node?.repository?.nameWithOwner;
    return typeof name === 'string' && name ? name : fallback;
}
