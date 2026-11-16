/**
 * How fresh a GitHub-backed view's data is, as one quiet line: "Updated 3m
 * ago", extra parts ("· plans 4m ago"), and then a spinner with "Updating…"
 * while a read is in flight, "Couldn't refresh" when the last one failed, or
 * "Paused: GitHub budget low until 14:20" while main holds GitHub's expensive
 * reads back (`state.github.heldUntil`). The words are `freshnessLine`'s.
 *
 * The ages follow the session list's ticking clock, as every other "ago" does.
 */
import type {JSX} from 'react';
import {useStore} from '../use-store';
import {FRESHNESS_SEPARATOR, freshnessLine} from './freshness-text';

export interface FreshnessProps {
    /** When the shown data was read from GitHub; null when never. */
    fetchedAt: number | null;
    /** A read is in flight right now. */
    refreshing?: boolean;
    /** The last read failed (the data shown is older). */
    failed?: boolean;
    /** Extra parts after the main age, e.g. [{label: 'plans', at: 1234}] → "· plans 4m ago". */
    parts?: readonly {label: string; at: number | null}[];
    /** Opt out of the held line where a view's reads are never held (lanes). Default true. */
    showHeld?: boolean;
}

export function Freshness(props: FreshnessProps): JSX.Element | null {
    const now = useStore((state) => state.sessionList.now) || Date.now();
    const heldUntil = useStore((state) => state.github.heldUntil);
    const line = freshnessLine(props, now, heldUntil);
    if (!line) return null;
    const status = line.status;
    return (
        <span className="freshness" data-testid="freshness">
            {line.ages}
            {line.ages !== null && status && FRESHNESS_SEPARATOR}
            {status && (
                <span className={`freshness-status is-${status.kind}`}>
                    {status.kind === 'refreshing' && <span className="freshness-spinner" aria-hidden="true" />}
                    {status.text}
                </span>
            )}
        </span>
    );
}
