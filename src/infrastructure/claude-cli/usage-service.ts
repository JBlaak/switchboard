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
import {transformUsageResponse} from '../../domain/usage/usage';
import {readOAuthToken} from './support/credentials';
import type {ApiUsage, Usage} from '../../domain/usage/usage';
import type {UsageService} from '../../application/ports/claude-cli';
import type {Logger} from '../../application/ports/logger';

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const REQUEST_TIMEOUT_MS = 10000;

/**
 * The request goes out the way Claude Code's own does: the endpoint only
 * accepts an OAuth token under the beta header, and it is the CLI's token.
 */
const CLI_HEADERS = {
    'Content-Type': 'application/json',
    'User-Agent': 'claude-code/2.1.74',
    'anthropic-beta': 'oauth-2025-04-20',
};

/** What the status bar gets for an answer, or for the lack of one. */
function toUsage(raw: ApiUsage | null): Usage {
    // No token, or a response the request already logged as an error.
    if (!raw) return {_error: true, message: 'No usage: Claude Code is not signed in, or the API refused'};
    if (raw._rateLimited) return {_rateLimited: true, retryAfterSeconds: raw.retryAfterSeconds};
    return transformUsageResponse(raw);
}

export class OAuthUsageService implements UsageService {
    constructor(private readonly log: Logger) {}

    public async fetch(): Promise<Usage> {
        try {
            return toUsage(await this.request());
        } catch (err) {
            // Offline, timed out, or a response that is not JSON.
            return {_error: true, message: (err as Error).message};
        }
    }

    private async request(): Promise<ApiUsage | null> {
        const oauth = readOAuthToken();
        if (!oauth?.accessToken) return null;

        const res = await globalThis.fetch(USAGE_ENDPOINT, {
            headers: {Authorization: `Bearer ${oauth.accessToken}`, ...CLI_HEADERS},
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
        return (await res.json()) as ApiUsage;
    }
}
