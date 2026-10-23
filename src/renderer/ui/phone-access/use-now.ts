/**
 * The time, re-read every `intervalMs` while `active`: for a countdown or a
 * "last seen" that has to move while it is on screen. Presentational only —
 * nothing is dispatched — and stopped as soon as nothing shows it.
 */
import { useEffect, useState } from 'react';

export function useNow(intervalMs: number, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, active]);
  return now;
}
