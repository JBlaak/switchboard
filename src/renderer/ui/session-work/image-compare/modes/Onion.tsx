/**
 * Onion skin (#116, M3): after laid over before, with a slider under the
 * stage for how much of after shows. Starts halfway; not saved.
 */
import { useState } from 'react';
import type { JSX } from 'react';
import { ImageStage } from '../ImageStage';
import { Layer } from './Layer';
import { contentSize } from './overlay';
import type { ModeProps } from './types';

export function Onion({ before, after, view, onView, onFrameSize, background }: ModeProps): JSX.Element {
  const content = contentSize(before, after);
  const [opacity, setOpacity] = useState(0.5);

  return (
    <div className="sw-onion">
      <ImageStage
        view={view}
        onView={onView}
        onFrameSize={onFrameSize}
        background={background}
        width={content.width}
        height={content.height}
      >
        <Layer image={before} />
        <Layer image={after} style={{ opacity }} />
      </ImageStage>
      <label className="sw-mode-controls">
        <span className="sw-mode-label">Before</span>
        <input
          className="sw-mode-slider"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={opacity}
          aria-label="After opacity"
          onChange={(event) => setOpacity(Number(event.currentTarget.value))}
        />
        <span className="sw-mode-label">After</span>
      </label>
    </div>
  );
}
