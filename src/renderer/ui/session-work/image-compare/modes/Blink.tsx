/**
 * Blink (#116, M4): one side at a time, flipped by hand. A click on the stage
 * flips it (as `b` does, through the card); a press that moved is a pan and
 * leaves it alone.
 *
 * Both sides stay mounted and only the hidden one is made invisible, so a
 * flip never waits on a decode.
 */
import { useRef } from 'react';
import type { JSX, PointerEvent as ReactPointerEvent } from 'react';
import { ImageStage } from '../ImageStage';
import { Layer } from './Layer';
import { contentSize, isClick } from './overlay';
import type { Point } from '../types';
import type { ModeProps } from './types';

export function Blink({ before, after, view, onView, onFrameSize, background, blink, onBlink }: ModeProps): JSX.Element {
  const content = contentSize(before, after);

  // The stage captures the pointer, so its up event still bubbles here.
  const press = useRef<(Point & { id: number }) | null>(null);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    press.current = event.button === 0 ? { id: event.pointerId, x: event.clientX, y: event.clientY } : null;
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const start = press.current;
    press.current = null;
    if (start?.id === event.pointerId && isClick(start, { x: event.clientX, y: event.clientY })) onBlink();
  };

  return (
    <div className="sw-blink" onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
      <ImageStage
        view={view}
        onView={onView}
        onFrameSize={onFrameSize}
        background={background}
        width={content.width}
        height={content.height}
      >
        <Layer image={before} style={{ visibility: blink === 'before' ? 'visible' : 'hidden' }} />
        <Layer image={after} style={{ visibility: blink === 'after' ? 'visible' : 'hidden' }} />
      </ImageStage>
      <span className="sw-blink-label">{blink === 'before' ? 'Before' : 'After'}</span>
    </div>
  );
}
