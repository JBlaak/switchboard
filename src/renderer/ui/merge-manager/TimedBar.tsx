/**
 * A Merge manager progress bar (the head card's steps, the Landing shelf's
 * head row): it fills on its own toward its step's expected time, and slides
 * once the step runs past it (`barProgress`).
 *
 * The fill is one CSS animation from where the bar is now to `FILL_CAP`, so
 * nothing redraws from JavaScript while it runs; it starts over only when the
 * read changes. A timer swaps it for the sliding segment when it runs out.
 */
import {useEffect, useMemo, useState, type CSSProperties, type JSX} from 'react';
import {barProgress, type BarTiming} from '../../../domain/merge-manager/progress';
import {firstSeen} from './first-seen';

export function TimedBar({
    className,
    timing,
    seenKey,
}: {
    /** The track's class: `mm-bar`, `landing-bar`. */
    className: string;
    timing: BarTiming | number;
    /** A PR and its step: what the bar times from when the read gives no start. */
    seenKey?: string;
}): JSX.Element {
    const [ranOut, setRanOut] = useState(0);
    const fixed = typeof timing === 'number' ? timing : null;
    const actual = typeof timing === 'number' ? null : timing.actual;
    const expectedMs = typeof timing === 'number' ? null : timing.expectedMs;
    const startedAt =
        typeof timing === 'number' ? null : (timing.startedAt ?? (seenKey !== undefined ? firstSeen(seenKey) : null));
    // Worked out once per read: a fresh `now` on every render would restart the fill.
    const bar = useMemo(
        () => barProgress(fixed ?? {actual, startedAt, expectedMs}, Date.now()),
        [fixed, actual, startedAt, expectedMs, ranOut],
    );
    useEffect(() => {
        if (bar.kind !== 'filling') return;
        const timer = setTimeout(() => setRanOut((n) => n + 1), bar.remainingMs + 50);
        return () => clearTimeout(timer);
    }, [bar]);
    return (
        <span className={className + ' timed-bar is-' + bar.kind} data-bar={bar.kind} aria-hidden="true">
            {bar.kind === 'fixed' && <span style={{width: Math.round(bar.value * 100) + '%'}} />}
            {bar.kind === 'filling' && (
                <span
                    key={`${bar.from}:${bar.remainingMs}`}
                    style={
                        {
                            '--bar-from': bar.from,
                            '--bar-to': bar.to,
                            animationDuration: bar.remainingMs + 'ms',
                        } as CSSProperties
                    }
                />
            )}
            {bar.kind === 'indeterminate' && <span />}
        </span>
    );
}
