/**
 * Side-by-side (#115, I1): before on the left, after on the right, each in a
 * stage of its own under the card's one view, so a zoom or pan on either
 * moves both.
 *
 * Both stages lay out the same content box, the larger of the two images on
 * each axis, with each image at its top-left: a pixel sits at the same spot
 * on both sides at any zoom. An animated image plays here (I3).
 */
import type { JSX } from 'react';
import { ImageStage } from '../ImageStage';
import type { Background, Size, View } from '../types';
import type { LoadedImage, ModeProps } from './types';

export function SideBySide({ before, after, view, onView, onFrameSize, background }: ModeProps): JSX.Element {
  const content = contentSize(before, after);
  const stage = { view, onView, onFrameSize, background, content };
  return (
    <div className="sw-side-by-side">
      <SideStage label="Before" image={before} {...stage} />
      <SideStage label="After" image={after} {...stage} />
    </div>
  );
}

/** The content box an image card lays out: the larger of the sides on each axis. */
export function contentSize(...images: (LoadedImage | null)[]): Size {
  return {
    width: Math.max(0, ...images.map(image => image?.width ?? 0)),
    height: Math.max(0, ...images.map(image => image?.height ?? 0)),
  };
}

/**
 * One labelled side in its own stage. Also what a card with a single side
 * (an added or deleted image, I5) draws on its own.
 */
export function SideStage({ label, image, content, view, onView, onFrameSize, background }: {
  label: string;
  image: LoadedImage;
  content: Size;
  view: View;
  onView(view: View): void;
  onFrameSize(frame: Size): void;
  background: Background;
}): JSX.Element {
  return (
    <figure className="sw-side" aria-label={label}>
      <figcaption className="sw-side-label">{label}</figcaption>
      <ImageStage
        view={view}
        onView={onView}
        onFrameSize={onFrameSize}
        background={background}
        width={content.width}
        height={content.height}
      >
        <img src={image.url} width={image.width} height={image.height} alt={label} draggable={false} />
      </ImageStage>
    </figure>
  );
}
