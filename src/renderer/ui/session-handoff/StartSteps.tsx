/**
 * Where a start handed off to a VM is: the steps it went through, ticked, and
 * the one it is on, with a spinner and how long it has been on it. A hand-off
 * can take a minute or more (the VM fetches the repository and makes the
 * worktree), and a button that only says "Starting…" all that time reads as
 * stuck.
 */
import {useEffect, useState, type JSX} from 'react';

export function StartSteps({vm, steps}: {vm: string; steps: readonly string[]}): JSX.Element {
    const current = steps.length - 1;
    const seconds = useSecondsOn(steps[current] ?? '');
    return (
        <div className="pv-inline is-progress" role="status" aria-label={'Starting on ' + vm}>
            <ol className="sb-start-steps">
                {steps.map((step, index) =>
                    index < current ? (
                        <li key={index} className="is-done">
                            <span className="sb-start-step-mark" aria-hidden="true">
                                ✓
                            </span>
                            {step}
                        </li>
                    ) : (
                        <li key={index} className="is-current" aria-current="step">
                            <span className="sb-start-step-mark is-spinner" aria-hidden="true" />
                            {step + '…'}
                            {seconds >= 3 && <span className="sb-start-step-time">{elapsed(seconds)}</span>}
                        </li>
                    ),
                )}
            </ol>
        </div>
    );
}

/** Whole seconds since `step` became the current one. */
function useSecondsOn(step: string): number {
    const [seconds, setSeconds] = useState(0);
    useEffect(() => {
        setSeconds(0);
        const since = Date.now();
        const timer = setInterval(() => setSeconds(Math.floor((Date.now() - since) / 1000)), 1000);
        return () => clearInterval(timer);
    }, [step]);
    return seconds;
}

/** 7 → "7s", 75 → "1:15". */
export function elapsed(seconds: number): string {
    if (seconds < 60) return seconds + 's';
    const minutes = Math.floor(seconds / 60);
    return minutes + ':' + String(seconds % 60).padStart(2, '0');
}
