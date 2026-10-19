/**
 * Asking Claude which project a typed request is for (#135).
 *
 * One request at a time: the box on the empty screen locks while it waits, so
 * a second request only arrives when the renderer has given up on the first,
 * and that one is cancelled rather than left to finish in the background. A
 * cancelled call is killed, not ignored — it runs on the user's own quota.
 *
 * The box warms a process when it gets focus (S2), and a request goes through
 * that one when it is there, through a cold call when it isn't.
 *
 * Never rejects. Every way this can go wrong ends with Patch saying one line
 * and the New Session picker opening, so a failure is just another answer.
 */
import { readRouteRun, routeArgs, routeBootArgs, routePrompt } from '../../domain/ask/route';
import type { RouteRequest, RouteResult } from '../../domain/ask/model';
import type { ClaudeRun } from '../../domain/ask/route';
import { WARM_IDLE_MS } from '../ports/claude-cli';
import type { ClaudeCaller, WarmCall } from '../ports/claude-cli';
import type { TimerHandle, Timers } from '../ports/clock';
import type { Logger } from '../ports/logger';

/** How long the user is kept waiting before the call counts as failed. */
export const ASK_ROUTE_TIMEOUT_MS = 30_000;

export const TIMEOUT_LINE = 'Claude took too long to answer. Pick the project yourself?';

interface InFlight {
  settle(result: RouteResult): void;
}

export class AskRouteService {
  #inFlight: InFlight | null = null;
  #warm: { call: WarmCall; timer: TimerHandle } | null = null;

  constructor(private readonly deps: {
    cli: ClaudeCaller;
    timers: Timers;
    log: Logger;
  }) {}

  /** Route one request; a request still in flight answers `cancelled`. */
  route(request: RouteRequest): Promise<RouteResult> {
    const { cli, timers, log } = this.deps;
    this.#inFlight?.settle({ kind: 'cancelled' });

    const controller = new AbortController();
    return new Promise((resolve) => {
      let settled = false;
      const flight: InFlight = {
        settle: (result) => {
          if (settled) return;
          settled = true;
          timers.clearTimeout(timer);
          if (this.#inFlight === flight) this.#inFlight = null;
          // A no-op once the call has ended; kills it when it hasn't.
          controller.abort();
          resolve(result);
        },
      };
      this.#inFlight = flight;

      const timer = timers.setTimeout(() => {
        log.warn('[ask] routing call timed out');
        flight.settle({ kind: 'failed', reason: TIMEOUT_LINE });
      }, ASK_ROUTE_TIMEOUT_MS);

      this.#run(request, controller.signal).then(
        (run) => {
          const result = readRouteRun(run, request);
          if (result.kind === 'failed') log.warn('[ask] routing call failed:', result.reason);
          flight.settle(result);
        },
        (err: Error) => flight.settle({ kind: 'failed', reason: `Couldn’t run claude: ${err.message}` }),
      );
    });
  }

  /**
   * Have a `claude` process booted and waiting for the next request (S2), so
   * the user waits on the model and not on the CLI starting. One at a time: a
   * second call while one is ready does nothing. One left unused is forgotten
   * once the caller has killed it for idling, so the next call warms afresh.
   */
  warm(): void {
    if (this.#warm) return;
    const { cli, timers } = this.deps;
    const timer = timers.setTimeout(() => { this.#warm = null; }, WARM_IDLE_MS);
    this.#warm = { call: cli.warm(routeBootArgs()), timer };
  }

  /** Through the warm process when there is one, which this uses up; otherwise a cold call. */
  #run(request: RouteRequest, signal: AbortSignal): Promise<ClaudeRun> {
    const warm = this.#warm;
    if (!warm) return this.deps.cli.call(routeArgs(request), signal);
    this.#warm = null;
    this.deps.timers.clearTimeout(warm.timer);
    return warm.call.send(routePrompt(request), signal);
  }

  /** Stop the request in flight, which then answers `cancelled`. */
  cancel(): void {
    this.#inFlight?.settle({ kind: 'cancelled' });
  }
}
