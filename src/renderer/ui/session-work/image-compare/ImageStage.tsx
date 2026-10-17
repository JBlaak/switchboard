/**
 * The frame every image-compare mode draws into (#114, C3/C4).
 *
 * Its children are laid out at their natural pixel size (`width` × `height`)
 * and moved as one by the controlled `view`; gestures go out through `onView`
 * as the next view from `viewport.ts`:
 *
 *  - pinch (a trackpad wheel with ctrlKey) and ⌘-scroll zoom toward the cursor;
 *    a plain wheel is left alone, so the page keeps scrolling over a card;
 *  - drag pans;
 *  - double-click switches between fit and 1:1 at the clicked point.
 *
 * The frame is as wide as its container and as tall as the content at fit,
 * so a card opens with no empty band under its image. It measures itself and
 * reports that size through `onFrameSize`, once on mount and on every resize:
 * that is the size the host passes to `fitView` (to open the card, and for
 * `0`). A child that handles its own drag (a swipe divider, a slider) stops
 * its `pointerdown` from propagating, so the stage does not pan as well.
 *
 * Behind the content is the background (a checkerboard, or flat light or
 * dark), drawn at screen size so its squares don't grow with the zoom. Past
 * 1:1 pixels are drawn square rather than smoothed, and from 8× a grid
 * outlines each one.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  CSSProperties, JSX, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode,
} from 'react';
import { panBy, showsGrid, toggleFitActual, zoomAt } from './viewport';
import type { Background, Point, Size, View } from './types';

export interface ImageStageProps {
  view: View;
  onView(view: View): void;
  background: Background;
  /** The content's natural size: the larger of the two images on each axis. */
  width: number;
  height: number;
  /** The frame's size in CSS pixels, on mount and whenever it changes. */
  onFrameSize?(frame: Size): void;
  children: ReactNode;
}

/** How fast a wheel delta zooms; a pinch sends small deltas, a mouse wheel large ones. */
const ZOOM_SPEED = 0.01;
/** The most one wheel event may zoom by, so a notched mouse wheel steps rather than jumps. */
const MAX_WHEEL_DELTA = 50;
/** Pixels in a wheel "line", for a mouse that reports lines rather than pixels. */
const LINE_PIXELS = 16;

export function ImageStage({ view, onView, background, width, height, onFrameSize, children }: ImageStageProps): JSX.Element {
  const frameRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState<Size>({ width: 0, height: 0 });
  const content: Size = { width, height };

  // The wheel listener and an in-flight drag read these rather than closing
  // over a render, so a gesture always starts from the latest view.
  const latest = useRef({ view, onView, frame, content });
  latest.current = { view, onView, frame, content };

  // The frame's width comes from the container; its height follows from that.
  const [containerWidth, setContainerWidth] = useState(0);
  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const measure = (): void => setContainerWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const frameHeight = width > 0 ? Math.round(height * Math.min(1, containerWidth / width)) : height;
  useLayoutEffect(() => {
    if (containerWidth === 0) return;
    const el = frameRef.current;
    // The stylesheet caps a very tall frame, so read back what it got.
    const next = { width: containerWidth, height: el ? el.clientHeight : frameHeight };
    setFrame((prev) => (prev.width === next.width && prev.height === next.height ? prev : next));
  }, [containerWidth, frameHeight]);

  const reported = useRef(onFrameSize);
  reported.current = onFrameSize;
  useEffect(() => {
    if (frame.width > 0) reported.current?.(frame);
  }, [frame]);

  // React's wheel listener is passive, and a zoom has to stop the page
  // scrolling, so this one is attached by hand.
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const { view: current, onView: emit, frame: size, content: natural } = latest.current;
      const delta = event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? LINE_PIXELS : 1);
      const step = Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, delta));
      emit(zoomAt(current, Math.exp(-step * ZOOM_SPEED), pointIn(el, event), size, natural));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // A drag pans from where it started, so moves that land between renders
  // are not lost.
  const drag = useRef<{ id: number; x: number; y: number; view: View } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, view };
    setDragging(true);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    onView(panBy(start.view, event.clientX - start.x, event.clientY - start.y, frame, content));
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
  };

  const onDoubleClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    onView(toggleFitActual(view, pointIn(event.currentTarget, event), frame, content));
  };

  // Where the content lands on screen, for the layers drawn at screen size.
  const box: CSSProperties = {
    left: view.x,
    top: view.y,
    width: width * view.scale,
    height: height * view.scale,
  };

  return (
    <div
      ref={frameRef}
      className={`sw-stage${dragging ? ' is-dragging' : ''}`}
      style={{ height: frameHeight }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onDoubleClick}
    >
      <div className={`sw-stage-backdrop is-${background}`} style={box} />
      <div
        className={`sw-stage-content${view.scale > 1 ? ' is-pixelated' : ''}`}
        style={{ width, height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
      >
        {children}
      </div>
      {showsGrid(view) && (
        <div className="sw-stage-grid" style={{ ...box, backgroundSize: `${view.scale}px ${view.scale}px` }} />
      )}
    </div>
  );
}

/** Where a pointer is, in the frame's own pixels. */
function pointIn(el: HTMLElement, event: { clientX: number; clientY: number }): Point {
  const rect = el.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}
