/**
 * The quota windows, from the OAuth usage endpoint.
 *
 * Called with the token Claude Code stores, which is why this is an adapter
 * rather than a plain fetch: the credentials, the endpoint and the beta header
 * are all the CLI's, and none of that belongs in a use case.
 *
 * Never rejects. A missing token, an offline machine and a rate limit are all
 * reported in the result, because the status bar has to render something.
 */
import { transformUsageResponse } from '../../domain/usage/usage';
import { readOAuthToken } from './credentials';
import type { ApiUsage, Usage } from '../../domain/usage/usage';
import type { UsageService } from '../../application/ports/claude-cli';
import type { Logger } from '../../application/ports/logger';

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const REQUEST_TIMEOUT_MS = 10000;

export class OAuthUsageService implements UsageService {
  constructor(private readonly log: Logger) {}

  async fetch(): Promise<Usage> {
    try {
      const raw = await this.#request();
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

  async #request(): Promise<ApiUsage | null> {
    const oauth = readOAuthToken();
    if (!oauth?.accessToken) return null;

    const res = await globalThis.fetch(USAGE_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${oauth.accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'claude-code/2.1.74',
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (res.status === 429) {
      return {
        _rateLimited: true,
        retryAfterSeconds: parseInt(res.headers.get('retry-after') || '0', 10),
      };
    }
    if (!res.ok) {
      this.log.error(`[usage] API error: ${res.status} ${res.statusText}`);
      return null;
    }
    return await res.json() as ApiUsage;
  }
}
