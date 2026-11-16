/**
 * Not landed's read: the user's open PRs, kept to the repositories the local
 * projects check out.
 *
 * One search finds every open PR of the user's across GitHub
 * (`openPullRequests`); the ones in a repository no local project checks out
 * are left out here, case aside, since a search cannot name them all.
 *
 * The renderer asks freely (on page open, and whenever the lanes change), so
 * a good answer is kept for 30 s and calls made while a read is under way
 * share it. When GitHub cannot be read, the last good answer stands; null
 * only when there never was one. Each answer says when GitHub was last read
 * well for it and whether the latest read failed, for the page's "Updated"
 * line.
 *
 * Always read on this Mac, also when merging is handed off to a VM: the
 * search is the user's, wherever the lanes run.
 */
import type {Clock} from '../ports/clock';
import type {GitHubCli} from '../ports/github-cli';
import type {NotLandedRead, OpenPullRequest} from '../../domain/merge-manager/not-landed';

/** How long a good answer is kept before GitHub is asked again. */
export const NOT_LANDED_FRESH_MS = 30_000;

export interface NotLandedServiceDeps {
    github: Pick<GitHubCli, 'openPullRequests'>;
    /** The `owner/repo` of each GitHub repository a local project checks out. */
    knownRepositories(): Promise<string[]>;
    clock: Clock;
}

export class NotLandedService {
    private last: {at: number; pullRequests: OpenPullRequest[]} | null = null;
    private inFlight: Promise<NotLandedRead> | null = null;
    /** The latest read failed. */
    private failed = false;

    constructor(private readonly deps: NotLandedServiceDeps) {}

    /** The user's open PRs in known projects; the last good answer when GitHub fails, null when there is none. */
    public read(): Promise<NotLandedRead> {
        if (this.last && this.deps.clock.now() - this.last.at < NOT_LANDED_FRESH_MS) {
            return Promise.resolve(this.answer());
        }
        if (!this.inFlight) {
            this.inFlight = this.fetch().finally(() => {
                this.inFlight = null;
            });
        }
        return this.inFlight;
    }

    private async fetch(): Promise<NotLandedRead> {
        const [open, known] = await Promise.all([
            this.deps.github.openPullRequests().catch(() => null),
            this.deps.knownRepositories().catch(() => null),
        ]);
        this.failed = !open || !known;
        if (open && known) {
            const wanted = new Set(known.map((repository) => repository.toLowerCase()));
            const pullRequests = open.filter((pr) => wanted.has(pr.repository.toLowerCase()));
            this.last = {at: this.deps.clock.now(), pullRequests};
        }
        return this.answer();
    }

    private answer(): NotLandedRead {
        return {pullRequests: this.last?.pullRequests ?? null, fetchedAt: this.last?.at ?? null, failed: this.failed};
    }
}
