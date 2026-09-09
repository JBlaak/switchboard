/**
 * Turning the OAuth usage endpoint's response into the gauges the status bar
 * shows.
 *
 * The API reports several limit windows at once — a 5-hour session window, a
 * weekly all-models window, and a weekly window per model — and which one bites
 * first varies. The 5-hour is usually the emptiest while resetting within the
 * day, so showing a single window would read as "plenty left" while a weekly one
 * is the one actually running out.
 */

/** One usage window as the API's `limits` array describes it. */
export interface UsageLimit {
  kind: string | null;
  label: string;
  model: string | null;
  percent: number;
  reset: string | null;
  severity: string;
}

/** The renderable usage summary handed to the renderer. */
export interface Usage {
  session?: number;
  sessionReset?: string | null;
  weekAll?: number;
  weekAllReset?: string | null;
  weekSonnet?: number;
  weekSonnetReset?: string | null;
  weekOpus?: number;
  weekOpusReset?: string | null;
  limits?: UsageLimit[];
  _error?: boolean;
  _rateLimited?: boolean;
  retryAfterSeconds?: number;
  message?: string;
}

/** One bucket in the raw API response. */
interface ApiBucket {
  utilization?: number | null;
  resets_at?: string | number | null;
}

interface ApiLimit {
  kind?: string;
  percent?: number | null;
  resets_at?: string | number | null;
  severity?: string;
  scope?: { model?: { display_name?: string } };
}

export interface ApiUsage {
  limits?: ApiLimit[];
  _rateLimited?: boolean;
  retryAfterSeconds?: number;
  [key: string]: unknown;
}

/**
 * A reset time as a short human string.
 *
 * Accepts an ISO string, epoch seconds or epoch millis — the API has used all
 * three. Within a day the date is dropped, since "3pm" is unambiguous and
 * shorter than a full timestamp in a status bar.
 */
export function formatResetTime(value: string | number | null | undefined, now = new Date()): string | null {
  if (!value) return null;
  let resetDate: Date;
  if (typeof value === 'string') {
    resetDate = new Date(value);
  } else if (value > 1e12) {
    resetDate = new Date(value);
  } else {
    resetDate = new Date(value * 1000);
  }
  if (isNaN(resetDate.getTime())) return null;

  const hours = resetDate.getHours();
  const minutes = resetDate.getMinutes();
  const ampm = hours >= 12 ? 'pm' : 'am';
  const h = hours % 12 || 12;
  const timeStr = minutes === 0 ? `${h}${ampm}` : `${h}:${String(minutes).padStart(2, '0')}${ampm}`;

  const tz = Intl.DateTimeFormat('en', { timeZoneName: 'short' }).formatToParts(resetDate)
    .find(p => p.type === 'timeZoneName')?.value || '';

  const diffMs = resetDate.getTime() - now.getTime();
  if (diffMs < 24 * 60 * 60 * 1000) return `${timeStr} (${tz})`;

  const month = resetDate.toLocaleString('en', { month: 'short' });
  return `${month} ${resetDate.getDate()} at ${timeStr} (${tz})`;
}

/** Copy one legacy flat bucket across, if the API still populates it. */
function mapBucket(
  apiUsage: ApiUsage,
  apiKey: string,
  usageKey: 'session' | 'weekAll' | 'weekSonnet' | 'weekOpus',
  usage: Usage,
): void {
  const bucket = apiUsage[apiKey] as ApiBucket | undefined;
  if (!bucket || bucket.utilization === null || bucket.utilization === undefined) return;
  usage[usageKey] = Math.floor(bucket.utilization);
  if (bucket.resets_at) usage[`${usageKey}Reset`] = formatResetTime(bucket.resets_at);
}

/**
 * Map the API's `limits` array into a renderable list.
 *
 * The per-model top-level buckets this used to read — seven_day_sonnet,
 * seven_day_opus, and a set of codenamed ones — now come back `null`. The live
 * data moved into `limits`, which is self-describing: each row carries its own
 * `kind`, `percent`, `resets_at`, and, for model-scoped windows, the model's
 * display name. Reading that means a newly launched model shows up on its own
 * instead of needing a new key added here every time one ships.
 */
function mapLimits(apiUsage: ApiUsage, usage: Usage): void {
  const rows = Array.isArray(apiUsage.limits) ? apiUsage.limits : [];
  const out: UsageLimit[] = [];
  for (const l of rows) {
    if (!l || l.percent === null || l.percent === undefined) continue;
    const model = l.scope?.model?.display_name || null;
    const label = l.kind === 'session' ? 'Current session'
      : l.kind === 'weekly_all' ? 'Week (all models)'
      : model ? `Week (${model})`
      : 'Week';
    out.push({
      kind: l.kind || null,
      label,
      model,
      percent: Math.floor(l.percent),
      reset: l.resets_at ? formatResetTime(l.resets_at) : null,
      severity: l.severity || 'normal',
    });
  }
  if (out.length) usage.limits = out;
}

export function transformUsageResponse(apiUsage: ApiUsage | null): Usage {
  if (!apiUsage) return {};
  const usage: Usage = {};
  // Legacy flat keys — kept because existing callers read usage.session /
  // usage.weekAll directly. five_hour and seven_day are still populated by the
  // API; the two model-specific ones are not, and are left in only so an older
  // response shape still maps.
  mapBucket(apiUsage, 'five_hour', 'session', usage);
  mapBucket(apiUsage, 'seven_day', 'weekAll', usage);
  mapBucket(apiUsage, 'seven_day_sonnet', 'weekSonnet', usage);
  mapBucket(apiUsage, 'seven_day_opus', 'weekOpus', usage);

  mapLimits(apiUsage, usage);

  // Backfill the legacy keys from `limits` if the flat buckets ever go null too,
  // so the status bar and any other flat-key reader keep working.
  for (const l of usage.limits || []) {
    if (l.kind === 'session' && usage.session === undefined) {
      usage.session = l.percent;
      if (l.reset) usage.sessionReset = l.reset;
    }
    if (l.kind === 'weekly_all' && usage.weekAll === undefined) {
      usage.weekAll = l.percent;
      if (l.reset) usage.weekAllReset = l.reset;
    }
  }
  return usage;
}

/** The short label a gauge is titled with — a status bar has no room for more. */
export function shortUsageLabel(row: UsageLimit): string {
  if (row.kind === 'session') return '5h';
  if (row.kind === 'weekly_all') return 'Week';
  return row.model || 'Week';
}

/**
 * The gauges to draw for a usage response.
 *
 * Prefers the API's self-describing rows, falling back to the flat 5-hour keys
 * so an older response shape still renders something.
 */
export function usageGaugeRows(usage: Usage | null | undefined): UsageLimit[] {
  if (Array.isArray(usage?.limits) && usage.limits.length) return usage.limits;
  if (usage?.session === undefined) return [];
  return [{
    kind: 'session',
    label: 'Current session',
    model: null,
    percent: usage.session,
    reset: usage.sessionReset ?? null,
    severity: 'normal',
  }];
}
