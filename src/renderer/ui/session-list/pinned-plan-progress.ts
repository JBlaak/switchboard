/**
 * Pinned plans' progress, for their rows in the session list: a row follows
 * its plan while it is on screen. The plan's stored copy shows at once (see
 * `stored-plans`), main is asked for the plan then, and again every
 * `PINNED_PLAN_POLL_MS` while any row follows one.
 */
import {dispatch} from '../../state/app-store';
import {issueKeyString} from '../../../domain/plan/model';
import type {IssueKey} from '../../../domain/plan/model';
import {storePlans, storedPlan} from '../session-work/plan/stored-plans';

/** How often the followed plans are asked for again: a sidebar glance, not the plan view's minute. */
export const PINNED_PLAN_POLL_MS = 5 * 60_000;

/** `owner/repo#n` → the plan and how many rows follow it. */
const followed = new Map<string, {issue: IssueKey; rows: number}>();
/** Plans being asked for right now, so a poll never stacks on a slow answer. */
const asking = new Set<string>();
let poll: ReturnType<typeof setInterval> | null = null;

/** Follow a pinned plan's progress while its row is on screen. Answers the unfollow. */
export function followPinnedPlan(issue: IssueKey): () => void {
    const planKey = issueKeyString(issue);
    const known = followed.get(planKey);
    if (known) {
        known.rows++;
    } else {
        followed.set(planKey, {issue: {repository: issue.repository, number: issue.number}, rows: 1});
        const stored = storedPlan(issue);
        if (stored) dispatch({type: 'planProgressLoaded', plans: [stored]});
        void load(issue);
    }
    poll ??= setInterval(() => {
        for (const {issue: next} of followed.values()) void load(next);
    }, PINNED_PLAN_POLL_MS);

    return () => {
        const entry = followed.get(planKey);
        if (entry && --entry.rows === 0) followed.delete(planKey);
        if (followed.size === 0 && poll) {
            clearInterval(poll);
            poll = null;
        }
    };
}

async function load(issue: IssueKey): Promise<void> {
    const planKey = issueKeyString(issue);
    if (asking.has(planKey)) return;
    asking.add(planKey);
    try {
        const plan = await window.api.plan(issue.repository, issue.number);
        if (!plan) return;
        dispatch({type: 'planProgressLoaded', plans: [plan]});
        storePlans([plan]);
    } catch {
        // The last progress stays on screen; the next poll asks again.
    } finally {
        asking.delete(planKey);
    }
}
