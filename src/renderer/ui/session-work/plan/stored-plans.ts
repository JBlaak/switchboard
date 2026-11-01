/**
 * The plans last loaded, kept in localStorage per `owner/repo#n`, so a plan
 * opened before (a pinned plan above all) shows at once while main asks
 * GitHub again, which takes a second or more.
 *
 * Only what GitHub said about the plan is kept. Which sessions own its issues
 * is never stored: the view asks for that anew (S1), so a stored copy cannot
 * claim a session that has since stopped. The newest `STORED_PLANS_MAX` are
 * kept, the oldest dropped.
 */
import {STORAGE_KEYS, readStored, writeStored} from '../../../state/storage';
import {issueKeyString} from '../../../../domain/plan/model';
import type {IssueKey, Plan} from '../../../../domain/plan/model';

/** How many plans are kept. */
export const STORED_PLANS_MAX = 30;

/** Newest first. */
export type StoredPlans = readonly Plan[];

/** The plans as stored; anything unreadable is dropped, which only costs it a quick first show. */
export function parseStoredPlans(raw: string | null): StoredPlans {
    if (!raw) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return [];
    }
    return Array.isArray(parsed) ? parsed.filter(isPlan).slice(0, STORED_PLANS_MAX) : [];
}

/** `plans` with `plan` first, in place of any older copy, kept to the newest `STORED_PLANS_MAX`. */
export function withStoredPlan(plans: StoredPlans, plan: Plan): StoredPlans {
    const key = issueKeyString(plan);
    const kept: Plan = {
        repository: plan.repository,
        number: plan.number,
        title: plan.title,
        parent: plan.parent,
        issues: plan.issues,
        outside: plan.outside,
    };
    return [kept, ...plans.filter((p) => issueKeyString(p) !== key)].slice(0, STORED_PLANS_MAX);
}

/** The stored copy of a plan, or null. */
export function findStoredPlan(plans: StoredPlans, issue: IssueKey): Plan | null {
    const key = issueKeyString(issue);
    return plans.find((p) => issueKeyString(p) === key) ?? null;
}

/** The stored copy of a plan, read from localStorage. */
export function storedPlan(issue: IssueKey): Plan | null {
    return findStoredPlan(parseStoredPlans(readStored('localStorage', STORAGE_KEYS.storedPlans)), issue);
}

/** Keep these plans, as main just answered them, as the newest stored. */
export function storePlans(plans: readonly Plan[]): void {
    if (!plans.length) return;
    let stored = parseStoredPlans(readStored('localStorage', STORAGE_KEYS.storedPlans));
    // The first answered ends up newest.
    for (const plan of [...plans].reverse()) stored = withStoredPlan(stored, plan);
    writeStored('localStorage', STORAGE_KEYS.storedPlans, JSON.stringify(stored));
}

function isPlan(value: unknown): value is Plan {
    if (!value || typeof value !== 'object') return false;
    const p = value as Partial<Plan>;
    return (
        typeof p.repository === 'string' &&
        typeof p.number === 'number' &&
        Number.isInteger(p.number) &&
        typeof p.title === 'string' &&
        (p.parent === null || typeof p.parent === 'object') &&
        Array.isArray(p.issues) &&
        Array.isArray(p.outside)
    );
}
