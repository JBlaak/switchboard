/**
 * One side of an overlay mode, laid at the content's top-left corner at its
 * natural size (M1).
 *
 * The overlay modes compare first frames (I3), so an animated GIF or WebP is
 * drawn from `pixels()` onto a canvas rather than left to play in an `<img>`.
 */
import { useEffect, useRef } from 'react';
import type { CSSProperties, JSX } from 'react';
import { drawPixels } from './draw';
import type { LoadedImage } from './types';

export function Layer({ image, style }: { image: LoadedImage; style?: CSSProperties }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (image.animated && canvasRef.current) drawPixels(canvasRef.current, image.pixels());
  }, [image]);

  return image.animated
    ? <canvas ref={canvasRef} className="sw-layer" style={style} />
    : <img className="sw-layer" src={image.url} width={image.width} height={image.height} alt="" draggable={false} style={style} />;
}
