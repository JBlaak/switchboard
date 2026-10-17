/**
 * Pixel diff (#116, M5): the changed pixels in Patch green over a faded,
 * greyscale after, drawn onto a canvas at natural size, with a threshold
 * slider and the share that changed underneath.
 *
 * The colours are read off the page, so the tint and the fade follow the
 * theme and the card's background; a scheme change (main flips
 * `nativeTheme`, which `prefers-color-scheme` follows) redoes the diff.
 * The work waits until after the next paint, and the slider is debounced,
 * so neither opening the mode nor dragging the slider stalls the card on a
 * large image. Until the first result lands the canvas stays empty and the
 * line says so; on a recompute the last result stays up.
 */
import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { ImageStage } from '../ImageStage';
import { pixelDiff } from '../pixel-diff';
import { backgroundColor, drawPixels, tokenColor } from './draw';
import { contentSize, describeChange } from './overlay';
import type { ModeProps } from './types';

/** pixelmatch's own default, which suits most re-exports and small edits. */
const DEFAULT_THRESHOLD = 0.1;
/** How long the slider has to rest before the diff is redone. */
const THRESHOLD_DEBOUNCE_MS = 150;
/** The query the renderer's light palette hangs off. */
const LIGHT_SCHEME_QUERY = '(prefers-color-scheme: light)';

export function PixelDiff({ before, after, view, onView, onFrameSize, background }: ModeProps): JSX.Element {
  const content = contentSize(before, after);
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);
  const [settled, setSettled] = useState(DEFAULT_THRESHOLD);
  const [summary, setSummary] = useState<string | null>(null);
  const scheme = useColorScheme();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(threshold), THRESHOLD_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [threshold]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A frame, then a task: the callback runs after that frame has painted.
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => {
        const canvas = canvasRef.current;
        if (cancelled || !canvas) return;
        const diff = pixelDiff(before.pixels(), after.pixels(), {
          threshold: settled,
          tint: tokenColor(canvas, '--sb-green', [0, 128, 0]),
          fade: backgroundColor(canvas, background),
        });
        drawPixels(canvas, diff.image);
        setSummary(describeChange(diff.changed, diff.total));
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [before, after, settled, background, scheme]);

  return (
    <div className="sw-pixel-diff">
      <ImageStage
        view={view}
        onView={onView}
        onFrameSize={onFrameSize}
        background={background}
        width={content.width}
        height={content.height}
      >
        <canvas ref={canvasRef} className="sw-layer" />
      </ImageStage>
      <div className="sw-mode-controls">
        <label className="sw-mode-label">
          Threshold
          <input
            className="sw-mode-slider"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={threshold}
            onChange={(event) => setThreshold(Number(event.currentTarget.value))}
          />
          <span className="sw-mode-value">{threshold.toFixed(2)}</span>
        </label>
        <span className="sw-pixel-diff-summary" aria-live="polite">{summary ?? 'Comparing…'}</span>
      </div>
    </div>
  );
}

/** Which colour scheme the page is in, re-rendering when it flips. */
function useColorScheme(): 'light' | 'dark' {
  const [scheme, setScheme] = useState<'light' | 'dark'>(() => (matchMedia(LIGHT_SCHEME_QUERY).matches ? 'light' : 'dark'));
  useEffect(() => {
    const query = matchMedia(LIGHT_SCHEME_QUERY);
    const onChange = (): void => setScheme(query.matches ? 'light' : 'dark');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return scheme;
}
