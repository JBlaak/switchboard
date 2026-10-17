/**
 * Swipe (#116, M2): before and after stacked top-left, after clipped to the
 * right of a vertical divider.
 *
 * The divider is held in content pixels, so a zoom or pan carries it along
 * with the image. Its line and handle are drawn over the stage at screen
 * size, so they stay the same size at any zoom; the handle takes its own drag
 * and stops it reaching the stage, which would pan.
 */
import { useRef, useState } from 'react';
import type { JSX, PointerEvent as ReactPointerEvent } from 'react';
import { ImageStage } from '../ImageStage';
import { Layer } from './Layer';
import { contentSize, dividerOnScreen, dragDivider, initialDivider } from './overlay';
import type { ModeProps } from './types';

export function Swipe({ before, after, view, onView, onFrameSize, background }: ModeProps): JSX.Element {
  const content = contentSize(before, after);
  const [divider, setDivider] = useState(() => initialDivider(content));

  const drag = useRef<{ id: number; x: number; divider: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, x: event.clientX, divider };
    setDragging(true);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    setDivider(dragDivider(start.divider, event.clientX - start.x, view, content));
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
  };

  return (
    <div className="sw-swipe">
      <ImageStage
        view={view}
        onView={onView}
        onFrameSize={onFrameSize}
        background={background}
        width={content.width}
        height={content.height}
      >
        <Layer image={before} />
        <Layer image={after} style={{ clipPath: `inset(0 0 0 ${divider}px)` }} />
      </ImageStage>
      <div className={`sw-swipe-divider${dragging ? ' is-dragging' : ''}`} style={{ left: dividerOnScreen(divider, view) }}>
        <div
          className="sw-swipe-handle"
          role="slider"
          aria-label="Swipe position"
          aria-valuemin={0}
          aria-valuemax={content.width}
          aria-valuenow={Math.round(divider)}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={(event) => event.stopPropagation()}
        />
      </div>
    </div>
  );
}
