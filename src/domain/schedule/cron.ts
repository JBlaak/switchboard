/**
 * Matching a 5-field cron expression against a moment.
 *
 * The scheduler ticks once a minute and asks each schedule whether now is its
 * time, rather than computing next-run times — which means a missed tick is a
 * skipped run rather than a burst of catch-up runs, and a schedule edited
 * mid-flight takes effect on the next minute.
 *
 * Supports `*`, steps (`*​/5`), lists (`1,3,5`) and ranges (`1-5`).
 */

function fieldMatches(field: string, value: number): boolean {
  if (field === '*') return true;
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    return Number.isFinite(step) && step > 0 && value % step === 0;
  }
  if (field.includes(',')) {
    return field.split(',').some(f => fieldMatches(f.trim(), value));
  }
  if (field.includes('-')) {
    const [lo, hi] = field.split('-').map(Number);
    return value >= lo && value <= hi;
  }
  return parseInt(field, 10) === value;
}

export function cronMatches(cronExpr: string, now: Date): boolean {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minute, hour, dom, month, dow] = parts;
  return (
    fieldMatches(minute, now.getMinutes()) &&
    fieldMatches(hour, now.getHours()) &&
    fieldMatches(dom, now.getDate()) &&
    fieldMatches(month, now.getMonth() + 1) &&
    fieldMatches(dow, now.getDay())
  );
}
