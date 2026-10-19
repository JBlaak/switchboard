/**
 * The Plan tab's GraphQL (#121): the queries `GhCli` sends for a plan, a
 * repository's plans, the plans issues belong to and the issues PRs close, and
 * how each answer maps onto the plan domain.
 *
 * Kept apart from `gh-cli.ts` so the mapping can be tested from recorded
 * responses on its own. Every number and repository written into a query's
 * text has been validated by the caller; the responses are read field by
 * field with a fallback for each, so they are typed `any`.
 */
import { layOutPlan } from '../../domain/plan/layout';
import { summariseIssueBody } from '../../domain/plan/issue-body';
import { issueKeyString, STANDALONE_PLAN_LABEL, type IssueKey, type Plan, type PlanIssue, type PlanPullRequest, type PlanSummary } from '../../domain/plan/model';
import type { PullRequestCloses } from '../../application/ports/github-cli';

/** Sub-issues per plan: the first 100, unpaged. */
export const SUB_ISSUES = 100;

/**
 * Plans per repository. GitHub refuses a query that could touch more than
 * 500,000 nodes before running it; 50 issues × 100 sub-issues × 20 blockers
 * stays well under, so the 50 most recently updated are asked for.
 */
export const PLANS_PER_REPOSITORY = 50;

const BLOCKER_FIELDS = 'number title state stateReason updatedAt repository { nameWithOwner }';

/** What a plan issue is drawn from: the sub-issues, or a standalone issue itself. */
const PLAN_ISSUE_FIELDS = `number title state stateReason updatedAt body
          repository { nameWithOwner }
          blockedBy(first: 50) { nodes { ${BLOCKER_FIELDS} } }
          closedByPullRequestsReferences(first: 20, includeClosedPrs: true) {
            nodes { number state isDraft additions deletions headRefName baseRefName }
          }`;

const LABELS = 'labels(first: 20) { nodes { name } }';

/** One plan: the issue, its parent, and each sub-issue with its blockers and closing PRs. */
export function planQuery(number: number): string {
  return `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    issue(number: ${number}) {
      ${PLAN_ISSUE_FIELDS}
      ${LABELS}
      parent { number title repository { nameWithOwner } }
      subIssues(first: ${SUB_ISSUES}) {
        nodes {
          ${PLAN_ISSUE_FIELDS}
        }
      }
    }
  }
}`;
}

/** A plan from `planQuery`'s data, or null when GitHub has no such issue. */
export function toPlan(data: any, repo: string): Plan | null {
  const node = data?.repository?.issue;
  if (!node || typeof node.number !== 'number') return null;
  const repository = nameOf(node, repo);
  const members = membersOf(node);

  const issues: PlanIssue[] = members.map((sub: any): PlanIssue => {
    const { summary, acceptance } = summariseIssueBody(typeof sub.body === 'string' ? sub.body : '');
    return {
      ...issueFields(sub, repository),
      blockedBy: blockersOf(sub, repository).map(keyOf),
      pullRequests: (sub.closedByPullRequestsReferences?.nodes ?? []).filter(Boolean).map(toPullRequest),
      summary,
      acceptance,
    };
  });

  // P5: a blocker that is not one of the plan's own issues, once each.
  const inPlan = new Set(issues.map(issueKeyString));
  const outside = new Map<string, PlanIssue>();
  for (const sub of members) {
    for (const blocker of blockersOf(sub, repository)) {
      const key = issueKeyString(keyOf(blocker));
      if (inPlan.has(key) || outside.has(key)) continue;
      outside.set(key, { ...issueFields(blocker, repository), blockedBy: [], pullRequests: [], summary: '', acceptance: [] });
    }
  }

  const parent = node.parent && typeof node.parent.number === 'number'
    ? { repository: nameOf(node.parent, repository), number: node.parent.number, title: node.parent.title ?? '' }
    : null;
  return { repository, number: node.number, title: node.title ?? '', parent, issues, outside: [...outside.values()] };
}

/** A repository's plans, by search, each with enough to lay it out. */
export const PLANS_QUERY = `query($search: String!) {
  search(type: ISSUE_ADVANCED, query: $search, first: ${PLANS_PER_REPOSITORY}) {
    nodes {
      ... on Issue {
        number title state stateReason updatedAt
        repository { nameWithOwner }
        ${LABELS}
        parent { number }
        blockedBy(first: 20) { nodes { number repository { nameWithOwner } } }
        subIssues(first: ${SUB_ISSUES}) {
          nodes {
            number state stateReason
            repository { nameWithOwner }
            blockedBy(first: 20) { nodes { number repository { nameWithOwner } } }
          }
        }
      }
    }
  }
}`;

/**
 * The search `PLANS_QUERY` runs: issues with sub-issues and standalone
 * `ready-for-agent` issues, open ones only unless closed ones are wanted (F3).
 */
export function plansSearch(repo: string, closed: boolean): string {
  const plans = `(has:sub-issue OR (label:${STANDALONE_PLAN_LABEL} no:parent-issue))`;
  return `repo:${repo} is:issue${closed ? '' : ' is:open'} ${plans} sort:updated-desc`;
}

/** The plans in `PLANS_QUERY`'s data, newest first, each counted and levelled by `layOutPlan`. */
export function toPlanSummaries(data: any, repo: string): PlanSummary[] | null {
  const nodes = data?.search?.nodes;
  if (!Array.isArray(nodes)) return null;
  const summaries: PlanSummary[] = [];
  for (const node of nodes) {
    if (!node || typeof node.number !== 'number') continue;
    const repository = nameOf(node, repo);
    const issues: PlanIssue[] = membersOf(node).map((sub: any): PlanIssue => ({
      ...issueFields(sub, repository),
      blockedBy: blockersOf(sub, repository).map(keyOf),
      pullRequests: [],
      summary: '',
      acceptance: [],
    }));
    if (issues.length === 0) continue;
    const layout = layOutPlan({ repository, number: node.number, title: node.title ?? '', parent: null, issues, outside: [] });
    summaries.push({
      repository,
      number: node.number,
      title: node.title ?? '',
      state: node.state === 'OPEN' ? 'open' : 'closed',
      updatedAt: node.updatedAt ?? '',
      open: issues.filter((issue) => issue.state === 'open').length,
      total: issues.length,
      current: layout.current,
      levels: layout.levels.length,
    });
  }
  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Each issue's parent and labels, one aliased field per issue, `i<index>`. */
export function plansOfQuery(issues: readonly IssueKey[]): string {
  const fields = issues.map((issue, index) => {
    const [owner, name] = issue.repository.split('/');
    return `i${index}: repository(owner: "${owner}", name: "${name}") { issue(number: ${issue.number}) { parent { number repository { nameWithOwner } } ${LABELS} } }`;
  });
  return `query { ${fields.join(' ')} }`;
}

/**
 * The plans in `plansOfQuery`'s data, once each, in the order their issues
 * were asked for: an issue's parent, or the issue itself when it is a
 * standalone `ready-for-agent` issue.
 */
export function toPlansOf(data: any, issues: readonly IssueKey[]): IssueKey[] {
  const plans = new Map<string, IssueKey>();
  issues.forEach((issue, index) => {
    const node = data?.['i' + index]?.issue;
    if (!node) return;
    const parent = node.parent;
    const key = parent && typeof parent.number === 'number'
      ? { repository: nameOf(parent, issue.repository), number: parent.number }
      : isLabelled(node) ? { repository: issue.repository, number: issue.number } : null;
    if (key) plans.set(issueKeyString(key), key);
  });
  return [...plans.values()];
}

/** The issues each PR closes, one aliased field per PR, `pr<number>`. */
export function closingIssuesQuery(numbers: readonly number[]): string {
  const fields = numbers.map((number) =>
    `pr${number}: pullRequest(number: ${number}) { number closingIssuesReferences(first: 20) { nodes { number repository { nameWithOwner } } } }`);
  return `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields.join(' ')} } }`;
}

export function toClosingIssues(data: any, repo: string, numbers: readonly number[]): PullRequestCloses[] | null {
  const repository = data?.repository;
  if (!repository) return null;
  const found: PullRequestCloses[] = [];
  for (const number of numbers) {
    const node = repository['pr' + number];
    if (!node) continue;
    const closes = (node.closingIssuesReferences?.nodes ?? [])
      .filter((issue: any) => issue && typeof issue.number === 'number')
      .map((issue: any): IssueKey => ({ repository: nameOf(issue, repo), number: issue.number }));
    found.push({ number, closes });
  }
  return found;
}

// ── Fields ──

/** A plan's issues: its sub-issues, or a standalone `ready-for-agent` issue on its own. */
function membersOf(node: any): any[] {
  const subs = (node.subIssues?.nodes ?? []).filter(Boolean);
  if (subs.length > 0) return subs;
  return !node.parent && isLabelled(node) ? [node] : [];
}

function isLabelled(node: any): boolean {
  return (node.labels?.nodes ?? []).some((label: any) => label?.name === STANDALONE_PLAN_LABEL);
}

function nameOf(node: any, fallback: string): string {
  const name = node?.repository?.nameWithOwner;
  return typeof name === 'string' && name ? name : fallback;
}

function keyOf(issue: IssueKey): IssueKey {
  return { repository: issue.repository, number: issue.number };
}

function blockersOf(node: any, repository: string): Array<IssueKey & { node: any }> {
  return (node.blockedBy?.nodes ?? [])
    .filter((blocker: any) => blocker && typeof blocker.number === 'number')
    .map((blocker: any) => ({ repository: nameOf(blocker, repository), number: blocker.number, node: blocker }));
}

/** What every plan issue carries, ghosts included. */
function issueFields(raw: any, repository: string): Omit<PlanIssue, 'blockedBy' | 'pullRequests' | 'summary' | 'acceptance'> {
  const node = raw.node ?? raw;
  const state = node.state === 'OPEN' ? 'open' : 'closed';
  return {
    repository: nameOf(node, repository),
    number: node.number,
    title: node.title ?? '',
    state,
    closedAs: state === 'open' ? null : closedAs(node.stateReason),
    updatedAt: node.updatedAt ?? '',
  };
}

/** Not planned and duplicate both close an issue without doing it (P6). */
function closedAs(reason: unknown): PlanIssue['closedAs'] {
  return reason === 'NOT_PLANNED' || reason === 'DUPLICATE' ? 'not_planned' : 'completed';
}

function toPullRequest(node: any): PlanPullRequest {
  return {
    number: node.number,
    state: node.state === 'MERGED' ? 'merged' : node.state === 'CLOSED' ? 'closed' : 'open',
    draft: node.isDraft === true,
    additions: typeof node.additions === 'number' ? node.additions : 0,
    deletions: typeof node.deletions === 'number' ? node.deletions : 0,
    headRef: node.headRefName ?? '',
    baseRef: node.baseRefName ?? '',
  };
}
