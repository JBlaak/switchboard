/**
 * A plan, as the Plan tab sees it: one issue and its direct sub-issues (P1),
 * with the "Blocked by" links between them, their PRs and a summary of each
 * body. A standalone issue labelled `ready-for-agent` is a plan too, with
 * itself as its one issue. The main process fills these from one GraphQL
 * request; the rules that turn a plan into levels, states and warnings live in
 * `layout.ts`.
 */

import type {AutomergeStatus} from '../project/merge-queue';

/** The label that makes an issue with no parent and no sub-issues a plan of its own. */
export const STANDALONE_PLAN_LABEL = 'ready-for-agent';

/**
 * The label of a wayfinder map: a plan whose tickets are decisions, worked
 * with `/wayfinder` rather than built to a PR. A labelled issue is a plan even
 * before it has a ticket.
 */
export const WAYFINDER_MAP_LABEL = 'wayfinder:map';

/** A wayfinder ticket's kind, from its `wayfinder:<type>` label. */
export type WayfinderTicketType = 'research' | 'prototype' | 'grilling' | 'task';

/** A GitHub issue. `repository` is `owner/repo`; two keys are the same issue when both parts agree. */
export interface IssueKey {
    repository: string;
    number: number;
}

/** A PR that closes an issue, by GitHub's closing references (P4). */
export interface PlanPullRequest {
    number: number;
    state: 'open' | 'merged' | 'closed';
    draft: boolean;
    additions: number;
    deletions: number;
    headRef: string;
    baseRef: string;
    /**
     * Only on a PR labelled `automerge:opt-in`: what the merge queue (#315)
     * last wrote on it, its `automerge` status, or null before its first pass.
     */
    queue?: {automerge: AutomergeStatus | null};
}

export interface PlanIssue extends IssueKey {
    title: string;
    state: 'open' | 'closed';
    closedAs: 'completed' | 'not_planned' | null;
    updatedAt: string;
    /** Native "Blocked by" links, to plan issues or to `plan.outside`; anything else is ignored. */
    blockedBy: IssueKey[];
    pullRequests: PlanPullRequest[];
    summary: string;
    acceptance: {text: string; done: boolean}[];
    /** On a wayfinder map: someone is assigned, which is how a session claims a ticket. */
    claimed?: boolean;
    /** On a wayfinder map: the ticket's kind, when it carries a `wayfinder:<type>` label. */
    ticketType?: WayfinderTicketType | null;
}

export interface Plan extends IssueKey {
    title: string;
    /** The issue above this one, shown as a breadcrumb only (P1). */
    parent: (IssueKey & {title: string}) | null;
    issues: PlanIssue[];
    /** Blockers outside the plan, drawn as ghosts (P5). */
    outside: PlanIssue[];
    /** Labelled `wayfinder:map`: its tickets start `/wayfinder`, and it has map launchers instead of Start level. */
    wayfinder?: boolean;
}

export interface PlanSummary extends IssueKey {
    title: string;
    state: 'open' | 'closed';
    updatedAt: string;
    open: number;
    total: number;
    current: number | null;
    levels: number;
    /** Labelled `wayfinder:map`. */
    wayfinder?: boolean;
}

/** P7. */
export type NodeState = 'merged' | 'closed' | 'not-planned' | 'review' | 'draft' | 'claimed' | 'ready' | 'locked';

export interface PlanLayout {
    /** Level 1 first; each row in drawing order (D1). */
    levels: IssueKey[][];
    /** 1-based; 0 for an issue that is not in the plan. */
    levelOf(issue: IssueKey): number;
    stateOf(issue: IssueKey): NodeState;
    /** The plan issues blocked by this one, in level and row order. */
    unlocks(issue: IssueKey): IssueKey[];
    /** The outside issues this one is blocked by (P5). */
    ghosts(issue: IssueKey): PlanIssue[];
    /** The 1-based level you are on (P3); null when the plan is cleared. */
    current: number | null;
    warnings: PlanWarning[];
}

/** D5. */
export type PlanWarning = {kind: 'no-links'} | {kind: 'closed-without-pr'; issue: IssueKey};

/** `owner/repo#n`: the string form of an issue key, for maps and IPC records. */
export function issueKeyString(issue: IssueKey): string {
    return issue.repository + '#' + issue.number;
}

export function sameIssue(a: IssueKey, b: IssueKey): boolean {
    return a.repository === b.repository && a.number === b.number;
}
