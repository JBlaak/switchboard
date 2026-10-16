/**
 * Which GitHub issues a session talked about.
 *
 * Tickets are GitHub issues (D10). The ones a PR closes show in that PR's
 * header; the rest get a small Issues group that links out, so a session that
 * discussed an issue without opening anything for it still shows it. There is
 * no API to ask "which issues did this conversation mean", so this reads the
 * conversation the way a person would: `#123`, `owner/repo#123`, a GitHub issue
 * URL, and the number a branch is named after.
 */
import { parseTranscriptLine } from '../session/transcript';
import type { IssueRef } from './model';

/**
 * `#123` or `owner/repo#123`, not preceded by anything that makes it part of a
 * longer token: `&#123;` is an HTML entity, `a#1` an anchor, `/#1` a URL path.
 * `closes|fixes|resolves #123` is the same mention with a keyword in front, so
 * it needs no pattern of its own.
 */
const MENTION = /(?:^|[^\w&#/.-])(?:([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+))?#(\d+)\b/g;

/** A GitHub issue URL. A pull request URL is a PR, not an issue, and is left alone. */
const ISSUE_URL = /https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\/issues\/(\d+)\b/g;

/** A leading number in a branch's last segment: `fix/123-foo`, `123_bar`, `issue/42`. */
const BRANCH_ISSUE = /(?:^|\/)(\d+)(?:[-_.]|$)/;

function key(issue: IssueRef): string {
  return issue.repository + '#' + issue.number;
}

/** Add an issue unless it is already there, keeping first-mention order. */
function addIssue(into: Map<string, IssueRef>, issue: IssueRef): void {
  if (issue.number > 0 && !into.has(key(issue))) into.set(key(issue), issue);
}

/**
 * The issues a piece of conversation text mentions, in the order it mentions
 * them, once each.
 *
 * A bare `#123` names an issue in the session's own repository, which the text
 * does not say; `repository` is that repository, or '' when it is not known.
 */
export function issueMentionsInText(text: string, repository: string): IssueRef[] {
  const found = new Map<string, IssueRef>();
  const hits: Array<{ at: number; issue: IssueRef }> = [];
  for (const match of text.matchAll(ISSUE_URL)) {
    hits.push({ at: match.index ?? 0, issue: { repository: match[1], number: Number(match[2]) } });
  }
  for (const match of text.matchAll(MENTION)) {
    hits.push({ at: match.index ?? 0, issue: { repository: match[1] ?? repository, number: Number(match[2]) } });
  }
  hits.sort((a, b) => a.at - b.at);
  for (const hit of hits) addIssue(found, hit.issue);
  return [...found.values()];
}

/**
 * The issue a branch is named after, or null.
 *
 * `fix/123-foo` is the usual way of saying "this branch is for #123", and is
 * often the only place a swarm agent's issue is recorded.
 */
export function issueFromBranch(branch: string, repository: string): IssueRef | null {
  const match = BRANCH_ISSUE.exec(branch);
  if (!match) return null;
  const number = Number(match[1]);
  return number > 0 ? { repository, number } : null;
}

/** The text blocks of a message, whatever shape it took. */
function messageTexts(message: unknown): string[] {
  if (typeof message === 'string') return [message];
  if (!message || typeof message !== 'object') return [];
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const block of content) {
    // Only what was said: tool results hold command output (a `gh issue list`
    // names every open issue), and thinking was never said to anyone.
    if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string') texts.push(text);
    }
  }
  return texts;
}

/**
 * The issues a transcript's conversation mentions: what you and Claude wrote
 * to each other, in the order it was written, once each.
 */
export function issueMentionsInTranscript(lines: readonly string[], repository: string): IssueRef[] {
  const found = new Map<string, IssueRef>();
  for (const line of lines) {
    const entry = parseTranscriptLine(line);
    if (!entry) continue;
    const role = entry.type === 'message' ? entry.role : entry.type;
    if (role !== 'user' && role !== 'assistant') continue;
    for (const text of messageTexts(entry.message)) {
      for (const issue of issueMentionsInText(text, repository)) addIssue(found, issue);
    }
  }
  return [...found.values()];
}

/**
 * The issues to list on their own: every mention once, minus the ones a PR
 * already closes (those show in the PR's header) and minus the session's own
 * PRs, which a conversation names as `#88` exactly like an issue.
 *
 * An empty repository on either side is "the session's repository", so `#12`
 * and `owner/repo#12` only count as the same issue when they agree or one of
 * them does not say.
 */
export function standaloneIssues(
  mentions: readonly IssueRef[],
  claimed: readonly IssueRef[],
): IssueRef[] {
  const isClaimed = (issue: IssueRef) => claimed.some((other) =>
    other.number === issue.number &&
    (other.repository === issue.repository || !other.repository || !issue.repository));
  const found = new Map<string, IssueRef>();
  for (const issue of mentions) {
    if (!isClaimed(issue)) addIssue(found, issue);
  }
  return [...found.values()];
}
