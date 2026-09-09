/**
 * The host's timers behind the Timers port.
 *
 * `clearTimeout` and `clearInterval` tolerate null, because almost every caller
 * is clearing a handle that may not have been set — a guard at each of those
 * call sites is noise.
 */
import type { Timers } from '../../application/ports/clock';

export const systemTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => {
    if (handle) clearTimeout(handle as NodeJS.Timeout);
  },
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => {
    if (handle) clearInterval(handle as NodeJS.Timeout);
  },
};
