/**
 * Time, as a dependency.
 *
 * Nothing in the application layer reads `Date.now()` or calls `setTimeout`
 * directly: a reconnect ladder, a kill escalation and a cron tick are all
 * decisions about time, and a test that has to wait three real seconds to check
 * one of them is a test nobody runs.
 */

export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
}

/** Opaque handle — the adapter decides what a timer actually is. */
export type TimerHandle = unknown;

export interface Timers {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle | null | undefined): void;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle | null | undefined): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};
