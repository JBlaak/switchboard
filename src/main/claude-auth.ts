// claude-auth.ts — Read Claude Code OAuth credentials and fetch usage data
// macOS: Keychain (primary) → ~/.claude/.credentials.json (fallback)
// Linux/Windows: ~/.claude/.credentials.json only

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

/** The OAuth blob Claude Code stores, as far as we read it. */
export interface ClaudeOAuth {
  accessToken?: string;
  [key: string]: unknown;
}

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

interface ApiUsage {
  limits?: ApiLimit[];
  _rateLimited?: boolean;
  retryAfterSeconds?: number;
  [key: string]: unknown;
}

export function getConfigDir(): string {
  return (process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
}

function getKeychainServiceName(): string {
  const suffix = '-credentials';
  if (process.env.CLAUDE_CONFIG_DIR) {
    const hash = crypto.createHash('sha256').update(getConfigDir()).digest('hex').substring(0, 8);
    return `Claude Code${suffix}-${hash}`;
  }
  return `Claude Code${suffix}`;
}

function readFromKeychain(): { claudeAiOauth?: ClaudeOAuth } | null {
  if (process.platform !== 'darwin') return null;
  try {
    const service = getKeychainServiceName();
    const user = process.env.USER || os.userInfo().username;
    // execFileSync (no shell) so $USER can't be interpolated into a command string
    const json = execFileSync(
      'security',
      ['find-generic-password', '-a', user, '-w', '-s', service],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    return JSON.parse(json) as { claudeAiOauth?: ClaudeOAuth };
  } catch (err) {
    console.error('[claude-auth] Keychain read error:', (err as Error).message);
    return null;
  }
}

function readFromFile(): { claudeAiOauth?: ClaudeOAuth } | null {
  try {
    const credPath = path.join(getConfigDir(), '.credentials.json');
    return JSON.parse(fs.readFileSync(credPath, 'utf8')) as { claudeAiOauth?: ClaudeOAuth };
  } catch (err) {
    console.error('[claude-auth] Credentials file read error:', (err as Error).message);
    return null;
  }
}

export function getOAuthToken(): ClaudeOAuth | null {
  const creds = readFromKeychain() || readFromFile();
  return creds?.claudeAiOauth || null;
}

function formatResetTime(value: string | number | null | undefined): string | null {
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
  const now = new Date();
  const diffMs = resetDate.getTime() - now.getTime();

  const hours = resetDate.getHours();
  const minutes = resetDate.getMinutes();
  const ampm = hours >= 12 ? 'pm' : 'am';
  const h = hours % 12 || 12;
  const timeStr = minutes === 0 ? `${h}${ampm}` : `${h}:${String(minutes).padStart(2, '0')}${ampm}`;

  const tz = Intl.DateTimeFormat('en', { timeZoneName: 'short' }).formatToParts(resetDate)
    .find(p => p.type === 'timeZoneName')?.value || '';

  if (diffMs < 0) return `${timeStr} (${tz})`;
  if (diffMs < 24 * 60 * 60 * 1000) return `${timeStr} (${tz})`;

  const month = resetDate.toLocaleString('en', { month: 'short' });
  const day = resetDate.getDate();
  return `${month} ${day} at ${timeStr} (${tz})`;
}

function mapBucket(
  apiUsage: ApiUsage,
  apiKey: string,
  usageKey: 'session' | 'weekAll' | 'weekSonnet' | 'weekOpus',
  usage: Usage,
): void {
  try {
    const u = apiUsage[apiKey] as ApiBucket | undefined;
    if (!u || u.utilization === null || u.utilization === undefined) return;
    usage[usageKey] = Math.floor(u.utilization);
    if (u.resets_at) usage[`${usageKey}Reset`] = formatResetTime(u.resets_at);
  } catch (err) {
    console.error('[claude-auth] Error mapping bucket', apiKey, (err as Error).message);
  }
}

/**
 * Map the API's `limits` array into a renderable list.
 *
 * The per-model top-level buckets this file used to read — seven_day_sonnet,
 * seven_day_opus, and a set of codenamed ones — now come back `null`. The live
 * data moved into `limits`, which is self-describing: each row carries its own
 * `kind`, `percent`, `resets_at`, and, for model-scoped windows, the model's
 * display name. Reading that means new models show up on their own instead of
 * needing a new key added here every time one ships.
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
      percent: Math.floor(l.percent!),
      reset: l.resets_at ? formatResetTime(l.resets_at) : null,
      severity: l.severity || 'normal',
    });
  }
  if (out.length) usage.limits = out;
}

function transformUsageResponse(apiUsage: ApiUsage | null): Usage {
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

export async function fetchUsage(): Promise<ApiUsage | null> {
  const oauth = getOAuthToken();
  if (!oauth?.accessToken) return null;

  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      'Authorization': `Bearer ${oauth.accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'claude-code/2.1.74',
      'anthropic-beta': 'oauth-2025-04-20',
    },
    signal: AbortSignal.timeout(10000),
  });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
    return { _rateLimited: true, retryAfterSeconds: retryAfter };
  }

  if (!res.ok) {
    console.error('[claude-auth] Usage API error:', res.status, res.statusText);
    return null;
  }
  return await res.json() as ApiUsage;
}

export async function fetchAndTransformUsage(): Promise<Usage> {
  try {
    const raw = await fetchUsage();
    if (raw === null) {
      return { _error: true, message: 'Could not fetch usage (no token or API error)' };
    }
    if (raw._rateLimited) {
      return { _rateLimited: true, retryAfterSeconds: raw.retryAfterSeconds };
    }
    return transformUsageResponse(raw);
  } catch (err) {
    return { _error: true, message: (err as Error).message };
  }
}
