/**
 * What Switchboard's GitHub GraphQL reads cost, and when to hold the
 * expensive ones back.
 *
 * GitHub gives a user 5,000 GraphQL points an hour, shared by everything
 * signed in as them. Every read asks `rateLimit { cost remaining resetAt }`
 * alongside its own fields, and the answer lands here under the read's label
 * (its method name): calls and points per label, the last cost per label, and
 * the last seen `remaining` and `resetAt`.
 *
 * When the budget runs low — fewer than `BUDGET_RESERVE` points left and the
 * reset still ahead — a read whose last cost was `EXPENSIVE_COST` or more is
 * held back, so the cheap ones the Merge manager and Land depend on keep
 * going. A `RATE_LIMIT` refusal carries no `rateLimit` field, so it pauses
 * the expensive reads for `RATE_LIMITED_PAUSE_MS`; the next answer that does
 * carry one says where the budget stands again. GitHub sometimes answers from
 * two budgets at random (one spent, one fresh), so the last answer always
 * wins: a fresh one lifts the hold, a spent one sets it again.
 *
 * Whoever shows the hold listens (`onHeldChanged`): told when it starts, moves
 * to another time, or lifts — by an answer, or by its time passing, which a
 * timer at that time notices when `timers` is given.
 *
 * Pure apart from its clock, timers and log, all injected.
 */
import type {Clock, TimerHandle, Timers} from '../../application/ports/clock';
import type {Logger} from '../../application/ports/logger';

/** Fewer points left than this (10% of 5,000) and expensive reads wait for the reset. */
export const BUDGET_RESERVE = 500;
/** A read whose last cost was this many points or more is expensive. */
export const EXPENSIVE_COST = 10;
/** The points summary is logged at most this often. */
/**
 * Reads never held back, whatever they cost: the Merge manager's lanes and
 * queue, which Land waits on. A lane read for many PRs can cost more than
 * `EXPENSIVE_COST`, and holding it would stall a landing.
 */
export const ESSENTIAL_READS: ReadonlySet<string> = new Set(['laneRead', 'queuedPullRequests', 'openPullRequests']);

export const SUMMARY_EVERY_MS = 10 * 60_000;
/** How long a `RATE_LIMIT` refusal holds expensive reads back, its reset unknown. */
export const RATE_LIMITED_PAUSE_MS = 5 * 60_000;

/** The `rateLimit` field of a GraphQL answer. */
export interface BudgetAnswer {
    cost: number;
    remaining: number;
    /** Epoch milliseconds. */
    resetAt: number;
}

export interface LabelSpend {
    calls: number;
    points: number;
    held: number;
    refused: number;
}

export class GraphqlBudget {
    private readonly clock: Clock;
    private readonly log: Pick<Logger, 'info'>;
    /** Spent since the last summary, per label. */
    private window = new Map<string, LabelSpend>();
    private windowStart: number;
    private readonly lastCost = new Map<string, number>();
    private remaining: number | null = null;
    private resetAt: number | null = null;
    /** Until when a `RATE_LIMIT` refusal holds expensive reads back. */
    private pausedUntil: number | null = null;
    /** The hold last logged, so it is logged once per reset window. */
    private loggedHold: number | null = null;
    private readonly timers: Timers | null;
    private readonly listeners = new Set<(until: number | null) => void>();
    /** The hold the listeners were last told about. */
    private toldHeld: number | null = null;
    /** Fires when the told hold's time passes, to tell that it lifted. */
    private liftTimer: TimerHandle | null = null;

    /** Without `timers`, a hold lifting by its time passing is told only with the next answer. */
    constructor(deps: {clock: Clock; log: Pick<Logger, 'info'>; timers?: Timers}) {
        this.clock = deps.clock;
        this.log = deps.log;
        this.timers = deps.timers ?? null;
        this.windowStart = deps.clock.now();
    }

    /**
     * Call `listener` with `heldUntil()` each time it changes: a time when a
     * hold starts or moves, null when it lifts. Answers the unsubscribe.
     */
    public onHeldChanged(listener: (until: number | null) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /**
     * May the read labelled `label` be sent? An essential one, a cheap one,
     * or one whose cost is not known yet, always may; an expensive one may not while the
     * budget is held. A refused read is counted and the hold logged once.
     */
    public allows(label: string): boolean {
        const cost = this.lastCost.get(label);
        if (ESSENTIAL_READS.has(label) || cost === undefined || cost < EXPENSIVE_COST) return true;
        const until = this.heldUntil();
        if (until === null) return true;
        this.spend(label).held++;
        if (this.loggedHold !== until) {
            this.loggedHold = until;
            const why =
                until === this.pausedUntil
                    ? 'GraphQL rate limit hit'
                    : `GraphQL budget low (${this.remaining} points left)`;
            this.log.info(`[github] ${why}: expensive reads paused until ${clockTime(until)}`);
        }
        return false;
    }

    /** A read labelled `label` was answered, with its `rateLimit` field when it had one. */
    public answered(label: string, budget: BudgetAnswer | null): void {
        const spend = this.spend(label);
        spend.calls++;
        if (budget) {
            spend.points += budget.cost;
            this.lastCost.set(label, budget.cost);
            this.remaining = budget.remaining;
            this.resetAt = budget.resetAt;
            this.pausedUntil = null;
        }
        this.tellHeld();
        this.maybeSummarise();
    }

    /** GitHub refused a read labelled `label` for the rate limit. */
    public rateLimited(label: string): void {
        const spend = this.spend(label);
        spend.calls++;
        spend.refused++;
        this.pausedUntil = this.clock.now() + RATE_LIMITED_PAUSE_MS;
        this.tellHeld();
        this.maybeSummarise();
    }

    /** Until when expensive reads are held back, or null when they are not. */
    public heldUntil(): number | null {
        const now = this.clock.now();
        if (this.pausedUntil !== null && now < this.pausedUntil) return this.pausedUntil;
        if (this.remaining !== null && this.resetAt !== null && this.remaining < BUDGET_RESERVE && now < this.resetAt)
            return this.resetAt;
        return null;
    }

    /** Tell the listeners when the hold changed, and watch for it lifting by its time. */
    private tellHeld(): void {
        const until = this.heldUntil();
        const changed = until !== this.toldHeld;
        // A timer woken a moment early finds the same hold: it looks again at its time.
        if (changed || this.liftTimer === null) {
            this.timers?.clearTimeout(this.liftTimer);
            this.liftTimer = null;
            if (until !== null && this.timers) {
                this.liftTimer = this.timers.setTimeout(
                    () => {
                        this.liftTimer = null;
                        this.tellHeld();
                    },
                    Math.max(0, until - this.clock.now()),
                );
            }
        }
        if (!changed) return;
        this.toldHeld = until;
        for (const listener of this.listeners) listener(until);
    }

    private spend(label: string): LabelSpend {
        let spend = this.window.get(label);
        if (!spend) {
            spend = {calls: 0, points: 0, held: 0, refused: 0};
            this.window.set(label, spend);
        }
        return spend;
    }

    /** Log the window's points per label, biggest first, once it is old enough and anything was spent. */
    private maybeSummarise(): void {
        const now = this.clock.now();
        if (now - this.windowStart < SUMMARY_EVERY_MS) return;
        const line = summaryLine(this.window, this.windowStart, this.remaining, this.resetAt);
        if (line === null) return;
        this.log.info(line);
        this.window = new Map();
        this.windowStart = now;
    }
}

/**
 * `[github] GraphQL points since 13:40: 412 — plansIn 208 (4 calls), plan 132 (3 calls, 2 held), …; 3810 left, resets 14:05`,
 * or null when nothing was spent.
 */
export function summaryLine(
    window: ReadonlyMap<string, LabelSpend>,
    since: number,
    remaining: number | null,
    resetAt: number | null,
): string | null {
    const rows = [...window.entries()].sort((a, b) => b[1].points - a[1].points || a[0].localeCompare(b[0]));
    const total = rows.reduce((sum, [, spend]) => sum + spend.points, 0);
    if (total === 0) return null;
    const parts = rows.map(([label, spend]) => {
        const held = spend.held > 0 ? `, ${spend.held} held` : '';
        const refused = spend.refused > 0 ? `, ${spend.refused} rate-limited` : '';
        return `${label} ${spend.points} (${spend.calls} call${spend.calls === 1 ? '' : 's'}${refused}${held})`;
    });
    const left =
        remaining === null ? '' : `; ${remaining} left` + (resetAt === null ? '' : `, resets ${clockTime(resetAt)}`);
    return `[github] GraphQL points since ${clockTime(since)}: ${total} — ${parts.join(', ')}${left}`;
}

/** `rateLimit` as GitHub answers it, or null when it is missing or malformed. */
export function toBudgetAnswer(field: unknown): BudgetAnswer | null {
    const value = field as {cost?: unknown; remaining?: unknown; resetAt?: unknown} | null | undefined;
    if (!value || typeof value !== 'object') return null;
    const resetAt = typeof value.resetAt === 'string' ? Date.parse(value.resetAt) : NaN;
    if (typeof value.cost !== 'number' || typeof value.remaining !== 'number' || Number.isNaN(resetAt)) return null;
    return {cost: value.cost, remaining: value.remaining, resetAt};
}

/** The alias the budget field is asked under, unlikely to clash with a query's own. */
export const BUDGET_ALIAS = '__budget';
const BUDGET_FIELD = `${BUDGET_ALIAS}: rateLimit { cost remaining resetAt }`;

/**
 * `query` asking for the budget too: the field goes first into the operation's
 * top-level selection (the first `{` outside the variable definitions). A
 * mutation, or text it cannot place the field in, is answered unchanged.
 */
export function withBudget(query: string): string {
    const start = query.trimStart();
    if (!/^(query\b|\{)/.test(start)) return query;
    let depth = 0;
    for (let i = 0; i < query.length; i++) {
        const char = query[i];
        if (char === '(') depth++;
        else if (char === ')') depth--;
        else if (char === '{' && depth === 0) return `${query.slice(0, i + 1)} ${BUDGET_FIELD}${query.slice(i + 1)}`;
    }
    return query;
}

/** HH:MM in local time. */
function clockTime(ms: number): string {
    const at = new Date(ms);
    return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}
