/**
 * The cycle provider over the Planner's public `GET /api/cycle/details`
 * (#412), which describes the current cycle or the one `?cycle=<n>` names.
 * It is keyed by number, not date, so a day is answered by asking for the
 * current cycle and, should the Planner's clock and ours sit either side of
 * the turn of a cycle, stepping to its neighbour. Like BlaakTasks' own
 * `PlannerCycleProvider`.
 *
 * One deadline covers both requests: a snooze menu waits on this, so a
 * Planner that hangs holds it up for 5 seconds at most, not 5 per request.
 * Never rejects; every failure is logged and answered null.
 */
import {neighbourFor, toCycle} from '../../domain/inbox/cycle';
import type {Cycle, PlannerCycle} from '../../domain/inbox/cycle';
import type {CycleProvider} from '../../application/ports/cycle-provider';
import type {Logger} from '../../application/ports/logger';

export const PLANNER_TIMEOUT_MS = 5000;

export interface PlannerCycleProviderOptions {
    fetch?: typeof globalThis.fetch;
    /** How long the whole question may take; 5 s unless a test says otherwise. */
    timeoutMs?: number;
}

export class PlannerCycleProvider implements CycleProvider {
    private readonly fetch: typeof globalThis.fetch;
    private readonly timeoutMs: number;

    constructor(
        private readonly log: Pick<Logger, 'warn'>,
        options: PlannerCycleProviderOptions = {},
    ) {
        this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
        this.timeoutMs = options.timeoutMs ?? PLANNER_TIMEOUT_MS;
    }

    public async cycleOn(plannerUrl: string, day: string): Promise<Cycle | null> {
        const base = plannerUrl.trim().replace(/\/+$/, '');
        if (!base) return null;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        // The deadline holds even for a body that never finishes or a fetch that ignores the signal.
        const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                controller.abort();
                reject(new Error('the Planner did not answer in time'));
            }, this.timeoutMs);
        });
        try {
            const ask = async (): Promise<PlannerCycle> => {
                const answer = await this.details(base, null, controller.signal);
                const neighbour = neighbourFor(answer, day);
                return neighbour === null ? answer : this.details(base, neighbour, controller.signal);
            };
            const cycle = toCycle(await Promise.race([ask(), deadline]));
            if (!cycle) this.log.warn('[planner] the answer has no cycle dates');
            return cycle;
        } catch (err) {
            this.log.warn('[planner] could not read the cycle:', (err as Error).message);
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    private async details(base: string, cycle: number | null, signal: AbortSignal): Promise<PlannerCycle> {
        const query = cycle === null ? '' : `?cycle=${cycle}`;
        const res = await this.fetch(`${base}/api/cycle/details${query}`, {
            headers: {accept: 'application/json'},
            signal,
        });
        if (!res.ok) throw new Error(`the Planner answered ${res.status}`);
        return (await res.json()) as PlannerCycle;
    }
}
