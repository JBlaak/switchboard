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
 *
 * Quick Ask (#142, R1) has an instance of its own, making its own call, so a
 * request from the pop-up and one from the empty screen never cancel each other.
 */
import { readRouteRun, routeArgs, routeBootArgs, routePrompt } from '../../domain/ask/route';
import type { QuickRouteResult, RouteRequest, RouteResult } from '../../domain/ask/model';
import type { ClaudeRun } from '../../domain/ask/route';
import { WARM_IDLE_MS } from '../ports/claude-cli';
import type { ClaudeCaller, WarmCall } from '../ports/claude-cli';
import type { TimerHandle, Timers } from '../ports/clock';
import type { Logger } from '../ports/logger';

/** How long the user is kept waiting before the call counts as failed. */
export const ASK_ROUTE_TIMEOUT_MS = 30_000;

export const TIMEOUT_LINE = 'Claude took too long to answer. Pick the project yourself?';

/** The routing call a service makes, and how it reads the answer. */
export interface RouteCall<R extends QuickRouteResult> {
  /** Every flag, for a warm process to boot on (S2). */
  bootArgs(): string[];
  /** The message, for a warm process. */
  prompt(request: RouteRequest): string;
  /** The whole argv of a cold call. */
  args(request: RouteRequest): string[];
  read(run: ClaudeRun, request: RouteRequest): R;
}

/** Ask Patch's call, from the empty screen. */
export const ASK_PATCH_CALL: RouteCall<RouteResult> = {
  bootArgs: routeBootArgs, prompt: routePrompt, args: routeArgs, read: readRouteRun,
};

/** How every call can end, whatever it asked. */
type Ended = Extract<RouteResult, { kind: 'cancelled' | 'failed' }>;

interface InFlight<R> {
  settle(result: R | Ended): void;
}

export class AskRouteService<R extends QuickRouteResult = RouteResult> {
  #inFlight: InFlight<R> | null = null;
  #warm: { call: WarmCall; timer: TimerHandle } | null = null;

  constructor(private readonly deps: {
    cli: ClaudeCaller;
    timers: Timers;
    log: Logger;
    /** Ask Patch's `ASK_PATCH_CALL`, or Quick Ask's. */
    call: RouteCall<R>;
  }) {}

  /** Route one request; a request still in flight answers `cancelled`. */
  route(request: RouteRequest): Promise<R | Ended> {
    const { cli, timers, log } = this.deps;
    this.#inFlight?.settle({ kind: 'cancelled' });

    const controller = new AbortController();
    return new Promise((resolve) => {
      let settled = false;
      const flight: InFlight<R> = {
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
          const result = this.deps.call.read(run, request);
          const read: QuickRouteResult = result;
          if (read.kind === 'failed') log.warn('[ask] routing call failed:', read.reason);
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
    this.#warm = { call: cli.warm(this.deps.call.bootArgs()), timer };
  }

  /** Through the warm process when there is one, which this uses up; otherwise a cold call. */
  #run(request: RouteRequest, signal: AbortSignal): Promise<ClaudeRun> {
    const warm = this.#warm;
    if (!warm) return this.deps.cli.call(this.deps.call.args(request), signal);
    this.#warm = null;
    this.deps.timers.clearTimeout(warm.timer);
    return warm.call.send(this.deps.call.prompt(request), signal);
  }

  /** Stop the request in flight, which then answers `cancelled`. */
  cancel(): void {
    this.#inFlight?.settle({ kind: 'cancelled' });
  }
}
