/**
 * Claude's pane under a two-finger sideways swipe (#377): left goes to the
 * next session, right to the previous one, in the order ⌘⇧] and ⌘⇧[ step
 * through (`swipeNeighbour` in features/terminal/session-nav), but without
 * wrapping round at the ends.
 *
 * While the swipe tracks, a small label with the session it would go to
 * slides in from the edge the fingers are moving away from, all the way in
 * once letting go would commit. At either end of the list there is nothing
 * there, so no label: the terminal gives a little under the fingers instead
 * and springs back.
 *
 * The listener is on the terminal's container, in the capture phase: xterm's
 * viewport stops the wheel events it scrolls by from bubbling, and the
 * recognizer only ever claims a stream locked sideways, so every vertical
 * scroll still reaches xterm untouched. A stream claimed as a swipe stops at
 * the container, so xterm never sees it.
 *
 * Only the session on screen listens, and not while its find bar is open or
 * the question sheet sits over it: whatever is on top handles its own wheel.
 * The reading page, Session work and the sheet are not inside the container,
 * so their wheel events never reach it.
 *
 * Under reduced motion nothing slides or gives: the switch just happens on a
 * committed swipe.
 */
import {useCallback, useRef, useState} from 'react';
import {useTrackpadSwipe} from '../use-trackpad-swipe';
import {useStore} from '../use-store';
import {motion, reducedMotion} from '../../lib/motion/spring';
import {pageCommitDistance, rubberBand, swipeProgress, swipeStep} from '../../../domain/gesture/swipe-paging';
import {swipeNeighbour, swipeToSession} from '../../features/terminal/session-nav';
import type {RefObject} from 'react';
import type {SwipeDirection} from '../use-trackpad-swipe';

/** The label of the session a swipe would go to. */
export interface PaneSwipeLabel {
    readonly direction: SwipeDirection;
    readonly name: string;
    readonly armed: boolean;
}

/** The gap, in px, between the label and the pane's edge once it is all the way in. */
const LABEL_INSET_PX = 16;

const sameLabel = (a: PaneSwipeLabel | null, b: PaneSwipeLabel | null): boolean =>
    a === b || (!!a && !!b && a.direction === b.direction && a.name === b.name && a.armed === b.armed);

export function usePaneSwipe(
    container: RefObject<HTMLDivElement | null>,
    sessionId: string,
    visible: boolean,
): {label: PaneSwipeLabel | null; labelRef: (el: HTMLDivElement | null) => void} {
    const searching = useStore((state) => state.terminal.searches[sessionId] !== undefined);
    const [label, setLabel] = useState<PaneSwipeLabel | null>(null);
    const show = (next: PaneSwipeLabel | null): void =>
        setLabel((current) => (sameLabel(current, next) ? current : next));

    /** How far in the label is (0 to 1) and from which side, for the label element when it mounts. */
    const travel = useRef<{direction: SwipeDirection; progress: number}>({direction: 'left', progress: 0});
    const labelEl = useRef<HTMLDivElement | null>(null);

    /** Where the label sits for `travel`: off the pane's edge at 0, inset from it at 1. */
    const placeLabel = (): void => {
        const el = labelEl.current;
        if (!el) return;
        const {direction, progress} = travel.current;
        // A swipe left brings the next session in from the right edge, so the label starts past it.
        const away = (el.offsetWidth + LABEL_INSET_PX * 2) * (direction === 'left' ? 1 : -1);
        motion(el).x.set(away * (1 - progress));
    };

    const labelRef = useCallback((el: HTMLDivElement | null) => {
        labelEl.current = el;
        // placeLabel only reads refs, so the callback can stay the same.
        placeLabel();
    }, []);

    const terminal = (): HTMLElement | null => container.current?.querySelector<HTMLElement>(':scope > .xterm') ?? null;

    /** Spring the terminal home, if it gave, and slide the label back out before it goes. */
    const settle = (): void => {
        const term = terminal();
        if (term) motion(term).x.to(0);
        const el = labelEl.current;
        if (!el || reducedMotion()) {
            show(null);
            return;
        }
        const {direction} = travel.current;
        const x = motion(el).x;
        x.onRest = () => {
            x.onRest = undefined;
            show(null);
        };
        x.to((el.offsetWidth + LABEL_INSET_PX * 2) * (direction === 'left' ? 1 : -1));
    };

    useTrackpadSwipe(
        container,
        {
            capture: true,
            commitDistance: (el) => pageCommitDistance(el.clientWidth),
            // The terminal scrolls nothing sideways, and xterm's own viewport must not count as a scroller.
            swipeInsideHorizontalScrollers: true,
            ignore: (event) =>
                !!container.current?.classList.contains('qp-under') ||
                (event.target instanceof Element && !!event.target.closest('.terminal-search-bar')),
            onTrack: (offset, armed) => {
                if (reducedMotion()) return;
                const direction: SwipeDirection = offset < 0 ? 'left' : 'right';
                const target = offset === 0 ? null : swipeNeighbour(swipeStep(direction));
                const term = terminal();
                if (!target) {
                    // Nothing that way: the terminal gives a little, and no label comes in.
                    if (term) motion(term).x.set(rubberBand(offset));
                    show(null);
                    return;
                }
                if (term && motion(term).x.x !== 0) motion(term).x.to(0);
                const el = container.current;
                const progress = swipeProgress(offset, pageCommitDistance(el?.clientWidth ?? 0));
                const x = labelEl.current ? motion(labelEl.current).x : null;
                if (x) x.onRest = undefined;
                travel.current = {direction, progress};
                show({direction, name: target.name, armed});
                placeLabel();
            },
            onCommit: (direction) => {
                const step = swipeStep(direction);
                // At an end a committed swipe has nowhere to go, and springs back like a short one.
                if (!swipeNeighbour(step)) {
                    settle();
                    return;
                }
                const term = terminal();
                if (term) motion(term).x.set(0);
                show(null);
                swipeToSession(step);
            },
            onCancel: settle,
        },
        visible && !searching,
    );

    return {label, labelRef};
}
