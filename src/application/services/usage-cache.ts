/**
 * The usage endpoint's last good answer, kept for whoever needs the week
 * without asking for it.
 *
 * The endpoint is rate-limited, and the footer already asks it on its own
 * timer. The Schedule manager pushes its facts on every run and save, and
 * each wants "how much of the week is used": asking the endpoint each time
 * would spend the budget the footer needs. So every fetch goes through here,
 * and the all-models week of the last answer that had one is kept.
 */
import type {Usage} from '../../domain/usage/usage';
import type {UsageService} from '../ports/claude-cli';

export class UsageCache implements UsageService {
    private week: number | null = null;

    constructor(private readonly inner: UsageService) {}

    public async fetch(): Promise<Usage> {
        const usage = await this.inner.fetch();
        if (!usage._error && !usage._rateLimited && typeof usage.weekAll === 'number') this.week = usage.weekAll;
        return usage;
    }

    /** The all-models weekly limit used, in percent, as last read; null before any good answer. */
    public latestWeek(): number | null {
        return this.week;
    }
}
