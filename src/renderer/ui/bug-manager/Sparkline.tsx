/**
 * A small line of a bug's events per day (#414): the rows' 7-day sparkline
 * and the detail's larger chart. Drawn to its box, the last day marked.
 *
 * The box is the same whatever it holds, so nothing moves when a trend
 * arrives: while it loads (`values` undefined) a faint shape with a soft
 * shimmer going across it; once it is in, the line draws itself and its fill
 * fades in; a trend that came back empty is a flat faint baseline. Under
 * reduced motion there is no shimmer and no drawing in.
 */
import {useId, type JSX} from 'react';

/** The loading shape's days, as fractions of the box's height: a gentle hill, nothing in particular. */
const SKELETON = [0.3, 0.42, 0.36, 0.55, 0.47, 0.62, 0.52];

export function Sparkline({
    values,
    width = 86,
    height = 26,
    label,
    fluid = false,
}: {
    /** Events per day, oldest first; undefined while they load. */
    values: readonly number[] | undefined;
    width?: number;
    height?: number;
    label: string;
    /** Drawn to its container's width, `width` only setting the drawing's proportions. */
    fluid?: boolean;
}): JSX.Element {
    const id = 'bm-spark-' + useId().replace(/[^a-zA-Z0-9_-]/g, '');
    const loading = values === undefined;
    const empty = !loading && values.length < 2;
    const className =
        'bm-spark' + (fluid ? ' is-fluid' : '') + (loading ? ' is-loading' : '') + (empty ? ' is-empty' : '');
    const base = height - 3;
    const box = {
        className,
        width: fluid ? undefined : width,
        height,
        preserveAspectRatio: fluid ? 'none' : undefined,
        viewBox: `0 0 ${width} ${height}`,
    };

    if (loading) {
        const shape = area(linePath(SKELETON, width, height, 1), width, height);
        return (
            <svg {...box} role="img" aria-label={`${label}: loading`} aria-busy="true">
                <defs>
                    <clipPath id={`${id}-clip`}>
                        <path d={shape} />
                    </clipPath>
                    <linearGradient id={`${id}-sweep`} x1="0" x2="1" y1="0" y2="0">
                        <stop offset="0" className="bm-spark-sweep-edge" />
                        <stop offset="0.5" className="bm-spark-sweep-mid" />
                        <stop offset="1" className="bm-spark-sweep-edge" />
                    </linearGradient>
                </defs>
                <path d={`M0 ${base} H${width}`} className="bm-spark-base" />
                <path d={shape} className="bm-spark-ghost" />
                <g clipPath={`url(#${id}-clip)`}>
                    <rect
                        className="bm-spark-sweep"
                        x={0}
                        y={0}
                        width={width / 2}
                        height={height}
                        fill={`url(#${id}-sweep)`}
                    />
                </g>
            </svg>
        );
    }

    if (empty) {
        return (
            <svg {...box} role="img" aria-label={`${label}: no events`}>
                <path d={`M0 ${base} H${width}`} className="bm-spark-base" />
            </svg>
        );
    }

    const max = Math.max(...values, 1);
    const line = linePath(values, width, height, max);
    const lastX = width;
    const lastY = y(values[values.length - 1]!, height, max);
    return (
        <svg {...box} role="img" aria-label={label}>
            <path d={`M0 ${base} H${width}`} className="bm-spark-base" />
            <path d={area(line, width, height)} className="bm-spark-fill" />
            <path d={line} className="bm-spark-line" pathLength={1} />
            <circle cx={lastX} cy={lastY} r="2.6" className="bm-spark-dot" />
        </svg>
    );
}

function y(value: number, height: number, max: number): number {
    return height - 3 - (value / max) * (height - 6);
}

function linePath(values: readonly number[], width: number, height: number, max: number): string {
    const step = width / (values.length - 1);
    return values
        .map((value, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)} ${y(value, height, max).toFixed(1)}`)
        .join(' ');
}

function area(line: string, width: number, height: number): string {
    return `${line} L${width} ${height} L0 ${height} Z`;
}
