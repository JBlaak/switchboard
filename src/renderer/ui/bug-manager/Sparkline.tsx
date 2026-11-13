/**
 * A small line of a bug's events per day (#414): the rows' 7-day sparkline
 * and the detail's larger chart. Drawn to its box, the last day marked.
 */
import type {JSX} from 'react';

export function Sparkline({
    values,
    width = 86,
    height = 26,
    label,
    fluid = false,
}: {
    values: readonly number[];
    width?: number;
    height?: number;
    label: string;
    /** Drawn to its container's width, `width` only setting the drawing's proportions. */
    fluid?: boolean;
}): JSX.Element {
    const className = 'bm-spark' + (fluid ? ' is-fluid' : '');
    if (values.length < 2) {
        return (
            <span className={className + ' is-empty'} style={fluid ? {height} : {width, height}} aria-hidden="true" />
        );
    }
    const max = Math.max(...values, 1);
    const step = width / (values.length - 1);
    const points = values.map((value, i) => [i * step, height - 3 - (value / max) * (height - 6)] as const);
    const line = points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
    const [lastX, lastY] = points[points.length - 1]!;
    return (
        <svg
            className={className}
            width={fluid ? undefined : width}
            height={height}
            preserveAspectRatio={fluid ? 'none' : undefined}
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={label}>
            <path d={`M0 ${height - 3} H${width}`} className="bm-spark-base" />
            <path d={`${line} L${width} ${height} L0 ${height} Z`} className="bm-spark-fill" />
            <path d={line} className="bm-spark-line" />
            <circle cx={lastX} cy={lastY} r="2.6" className="bm-spark-dot" />
        </svg>
    );
}
