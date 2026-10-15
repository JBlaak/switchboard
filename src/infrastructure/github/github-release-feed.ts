/**
 * GitHub's `releases/latest` behind the ReleaseFeed port.
 *
 * Unauthenticated, which GitHub allows sixty times an hour per address — far
 * more than a check every few hours needs. A repository with no published
 * release answers 404, which is "nothing new" rather than a failure.
 */
import { parseLatestRelease } from '../../domain/update/release';
import type { PublishedRelease } from '../../domain/update/release';
import type { ReleaseFeed } from '../../application/ports/updates';

const TIMEOUT_MS = 15_000;

export class GitHubReleaseFeed implements ReleaseFeed {
  constructor(private readonly repo: { owner: string; name: string }) {}

  async latest(): Promise<PublishedRelease | null> {
    const url = `https://api.github.com/repos/${this.repo.owner}/${this.repo.name}/releases/latest`;
    const response = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    return parseLatestRelease(await response.json());
  }
}
