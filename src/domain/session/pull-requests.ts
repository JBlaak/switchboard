/**
 * The pull requests a session opened, and which of them a row has room for.
 *
 * The CLI records every PR created or linked in a conversation as a `pr-link`
 * line in the transcript — including the ones its subagents opened, so the main
 * transcript alone is enough. It also writes the same line again with the
 * bookkeeping block it appends on exit and resume, which is why a transcript
 * can name one PR dozens of times and why the list is de-duplicated by URL.
 */
import type { SessionPullRequest } from './session';

/** How many PR chips a sidebar row shows before collapsing the rest into `+N`. */
export const VISIBLE_PULL_REQUESTS = 2;

/** The fields a `pr-link` line carries. Every one is best-effort. */
export interface PullRequestLink {
  prNumber?: unknown;
  prUrl?: unknown;
  prRepository?: unknown;
}

/**
 * A pull request from a `pr-link` line, or null when the line cannot be one.
 *
 * The URL ends up in a click handler that opens the browser, so only an https
 * URL is accepted: a transcript is a file anything on the machine can write,
 * and a chip must not become a way to hand the OS an arbitrary scheme.
 */
export function pullRequestFromLink(link: PullRequestLink): SessionPullRequest | null {
  const { prNumber, prUrl, prRepository } = link;
  if (typeof prNumber !== 'number' || !Number.isInteger(prNumber) || prNumber <= 0) return null;
  if (typeof prUrl !== 'string' || !/^https:\/\/\S+$/i.test(prUrl)) return null;
  return {
    number: prNumber,
    url: prUrl,
    repository: typeof prRepository === 'string' ? prRepository : '',
  };
}

/**
 * Read a cached PR list back, tolerating anything a cache can hold.
 *
 * A row written before the column existed holds NULL, and a row written by some
 * other build could hold anything at all; neither may stop the sidebar
 * rendering, so both read as "no pull requests". Each entry goes back through
 * the same check as a transcript line, for the same reason.
 */
export function decodePullRequests(json: string | null | undefined): SessionPullRequest[] {
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const result: SessionPullRequest[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const { number, url, repository } = item as Record<string, unknown>;
    const pr = pullRequestFromLink({ prNumber: number, prUrl: url, prRepository: repository });
    if (pr) result.push(pr);
  }
  return result;
}

/** `owner/repo#1309`, or just `#1309` when the transcript did not name the repo. */
export function pullRequestLabel(pr: SessionPullRequest): string {
  return (pr.repository || '') + '#' + pr.number;
}

/** What a row shows: a few chips, and how many were left out. */
export interface PullRequestChips {
  /** Newest first. */
  shown: SessionPullRequest[];
  /** Oldest last, in the order the `+N` chip's tooltip lists them. */
  hidden: SessionPullRequest[];
}

/**
 * Pick the chips a row has room for.
 *
 * The newest PRs are the ones worth a click — older ones in a long session are
 * usually merged — so the row shows the most recent and folds the rest into a
 * `+N`. `pullRequests` is chronological, as the transcript recorded them.
 */
export function pullRequestChips(
  pullRequests: readonly SessionPullRequest[] | null | undefined,
  visible = VISIBLE_PULL_REQUESTS,
): PullRequestChips {
  const newestFirst = [...(pullRequests ?? [])].reverse();
  return { shown: newestFirst.slice(0, visible), hidden: newestFirst.slice(visible) };
}
