/**
 * Asking Claude which project a typed request is for (#135).
 *
 * One request at a time: the box on the empty screen locks while it waits, so
 * a second request only arrives when the renderer has given up on the first,
 * and that one is cancelled rather than left to finish in the background. A
 * cancelled call is killed, not ignored — it runs on the user's own quota.
 *
 * Never rejects. Every way this can go wrong ends with Patch saying one line
 * and the New Session picker opening, so a failure is just another answer.
 */
import { readRouteRun, routeArgs } from '../../domain/ask/route';
import type { RouteRequest, RouteResult } from '../../domain/ask/model';
import type { ClaudeCaller } from '../ports/claude-cli';
import type { Timers } from '../ports/clock';
import type { Logger } from '../ports/logger';

/** How long the user is kept waiting before the call counts as failed. */
export const ASK_ROUTE_TIMEOUT_MS = 30_000;

export const TIMEOUT_LINE = 'Claude took too long to answer. Pick the project yourself?';

interface InFlight {
  settle(result: RouteResult): void;
}

export class AskRouteService {
  #inFlight: InFlight | null = null;

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

      cli.call(routeArgs(request), controller.signal).then(
        (run) => {
          const result = readRouteRun(run, request);
          if (result.kind === 'failed') log.warn('[ask] routing call failed:', result.reason);
          flight.settle(result);
        },
        (err: Error) => flight.settle({ kind: 'failed', reason: `Couldn’t run claude: ${err.message}` }),
      );
    });
  }

  /** Stop the request in flight, which then answers `cancelled`. */
  cancel(): void {
    this.#inFlight?.settle({ kind: 'cancelled' });
  }
}
