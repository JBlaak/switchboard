/**
 * The shapes the diff's loading skeleton draws (`DiffSkeleton`): a few file
 * cards, each a header with a path and a counts pill over lines of code.
 *
 * The widths are fixed, not random, so the skeleton looks the same on every
 * render and in every screenshot; they vary enough to read as code. A couple
 * of lines per card are an addition or a deletion, tinted like the real ones.
 */

/** How a skeleton line is tinted: like a context line, an addition or a deletion. */
export type SkeletonLineKind = 'context' | 'add' | 'delete';

export interface SkeletonLine {
    readonly kind: SkeletonLineKind;
    /** Leading indentation, in characters. */
    readonly indent: number;
    /** The code bar's width, as a percentage of the line. */
    readonly width: number;
}

export interface SkeletonCard {
    /** The path bar's width in the header, as a percentage of the header. */
    readonly path: number;
    readonly lines: readonly SkeletonLine[];
}

const ctx = (indent: number, width: number): SkeletonLine => ({kind: 'context', indent, width});
const add = (indent: number, width: number): SkeletonLine => ({kind: 'add', indent, width});
const del = (indent: number, width: number): SkeletonLine => ({kind: 'delete', indent, width});

export const SKELETON_CARDS: readonly SkeletonCard[] = [
    {
        path: 38,
        lines: [ctx(0, 46), ctx(4, 62), del(4, 54), add(4, 58), add(8, 34), ctx(4, 22), ctx(0, 8), ctx(0, 40)],
    },
    {
        path: 27,
        lines: [ctx(0, 52), ctx(4, 30), add(4, 66), ctx(4, 44), del(8, 48), ctx(0, 12), ctx(0, 36)],
    },
    {
        path: 44,
        lines: [ctx(4, 40), del(4, 50), add(4, 56), ctx(4, 28), ctx(0, 10), ctx(0, 60)],
    },
];
