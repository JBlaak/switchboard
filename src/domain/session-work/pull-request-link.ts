/**
 * A pull request link, wherever the app meets one: a terminal, a chip, a
 * Markdown link, a project page row. Every one of them opens in the browser.
 *
 * A PR no session opened can have a work page of its own, keyed by a page id
 * that can never be a session's (`pullRequestPageId`): the page shows the PR
 * alone, its diff, its threads and your review, and hands nothing to Claude.
 */

/** Which pull request: `owner/repo` and its number. */
export interface PullRequestRef {
    repository: string;
    number: number;
}

const PULL_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i;

/**
 * The PR a URL points at: any page of it (`/files`, `/checks`, a comment
 * anchor) counts. Null for anything that is not a github.com pull request.
 */
export function parsePullRequestUrl(url: string): PullRequestRef | null {
    const match = PULL_URL.exec(url.trim());
    if (!match) return null;
    const number = Number(match[3]);
    if (!Number.isSafeInteger(number) || number <= 0) return null;
    return {repository: `${match[1]}/${match[2]}`, number};
}

/** The PR's page on GitHub. */
export function pullRequestUrl(ref: PullRequestRef): string {
    return `https://github.com/${ref.repository}/pull/${ref.number}`;
}

const PAGE_PREFIX = 'pull:';

/** The work page id of a PR no session owns: `pull:owner/repo#12`. Never a session id. */
export function pullRequestPageId(ref: PullRequestRef): string {
    return `${PAGE_PREFIX}${ref.repository}#${ref.number}`;
}

/** The PR a work page id is for; null for a session's own page. */
export function pullRequestPageRef(pageId: string): PullRequestRef | null {
    if (!pageId.startsWith(PAGE_PREFIX)) return null;
    const rest = pageId.slice(PAGE_PREFIX.length);
    const hash = rest.lastIndexOf('#');
    if (hash <= 0) return null;
    const repository = rest.slice(0, hash);
    const number = Number(rest.slice(hash + 1));
    if (!/^[^/\s]+\/[^/\s]+$/.test(repository) || !Number.isSafeInteger(number) || number <= 0) return null;
    return {repository, number};
}

/** Whether a work page id is a PR's own page rather than a session's. */
export function isPullRequestPageId(pageId: string): boolean {
    return pullRequestPageRef(pageId) !== null;
}

/** Two refs name the same PR. GitHub's owner and repo names are case-insensitive. */
export function samePullRequest(a: PullRequestRef, b: PullRequestRef): boolean {
    return a.number === b.number && a.repository.toLowerCase() === b.repository.toLowerCase();
}
