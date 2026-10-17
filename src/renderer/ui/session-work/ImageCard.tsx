/**
 * An image's card body in the diff (#115): both versions, compared.
 *
 * It loads both sides once it is drawn (L1), unless one is too big to load
 * by itself, in which case it starts collapsed behind Show diff like a large
 * text file. Over the images: the mode toolbar (all five, or only
 * side-by-side when the file was added or deleted, I5), the background and
 * the metadata line. The mode, the view and the blink side are the card's
 * own, in the slice; the mode last picked and the background are every new
 * card's (C1, C3). An image that will not decode falls back to the binary
 * row (L4).
 */
import type { JSX } from 'react';
import type { FileDiff } from '../../../domain/session-work/model';
import { comparesImages } from '../../state/session-work-slice';
import type { ImageCardState } from '../../state/session-work-slice';
import { blinkImage, frameImage, setImageBackground, setImageMode, viewImage } from './actions';
import {
  IMAGE_BACKGROUND_LABEL, IMAGE_FIRST_FRAME, IMAGE_MODE_LABEL, IMAGE_UNREADABLE, imageCollapsedText,
} from './describe';
import { describeImages } from './image-compare/image-meta';
import { modeView } from './image-compare/modes';
import { SideStage, contentSize } from './image-compare/modes/SideBySide';
import { IMAGE_MODES } from './image-compare/modes/types';
import type { ImageMode } from './image-compare/modes/types';
import { fitView } from './image-compare/viewport';
import type { Background, Size, View } from './image-compare/types';
import { useImagePair } from './image-load';

/** Drawn under until the stage first measures its frame; hidden meanwhile (see `is-fitting`). */
const PLACEHOLDER_VIEW: View = { scale: 1, x: 0, y: 0 };
const SIDE_BY_SIDE_ONLY: readonly ImageMode[] = ['side-by-side'];
const BACKGROUNDS: readonly Background[] = ['checkerboard', 'light', 'dark'];

export function ImageCard({
  sessionId, itemId, file, loadKey, expanded, card, background, defaultMode, onShowDiff,
}: {
  sessionId: string;
  itemId: string;
  /** A file with an `image`. */
  file: FileDiff;
  /** The item's diff as it was asked for: a new one loads the images again. */
  loadKey: string;
  /** Opened with Show diff. */
  expanded: boolean;
  /** Undefined until the card's stage first reports its frame. */
  card: ImageCardState | undefined;
  background: Background;
  defaultMode: ImageMode;
  onShowDiff(): void;
}): JSX.Element {
  const image = file.image!;
  const reason = imageCollapsedText(image);
  const collapsed = reason !== null && !expanded;
  const pair = useImagePair(sessionId, itemId, file, loadKey, !collapsed);

  if (collapsed) {
    return (
      <div className="sw-file-row is-collapsed">
        <span>{reason}</span>
        <button type="button" className="sw-btn sw-btn-small" onClick={onShowDiff}>
          Show diff
        </button>
      </div>
    );
  }
  if (pair.phase === 'failed') {
    return (
      <div className="sw-file-row">
        {image.format !== 'svg' && <span>Binary file changed</span>}
        <span className="sw-image-note">{IMAGE_UNREADABLE}</span>
      </div>
    );
  }
  if (pair.phase === 'loading') return <div className="sw-image-loading"><div className="sw-skeleton" /></div>;

  const { before, after } = pair;
  const { path } = file;
  const compares = comparesImages(file) && !!before && !!after;
  const mode = compares ? card?.mode ?? defaultMode : 'side-by-side';
  const content = contentSize(before, after);
  const meta = describeImages(
    image.format,
    before && image.before && { width: before.width, height: before.height, bytes: image.before.bytes },
    after && image.after && { width: after.width, height: after.height, bytes: image.after.bytes },
  );
  const firstFrame = mode !== 'side-by-side' && (!!before?.animated || !!after?.animated);

  const view = card?.view ?? PLACEHOLDER_VIEW;
  const onView = (next: View): void => viewImage(itemId, path, next);
  const onFrameSize = (frame: Size): void => frameImage(itemId, path, fitView(frame, content));

  let stage: JSX.Element;
  if (compares) {
    const Mode = modeView(mode);
    stage = (
      <Mode
        before={before}
        after={after}
        view={view}
        onView={onView}
        onFrameSize={onFrameSize}
        background={background}
        blink={card?.blink ?? 'before'}
        onBlink={() => blinkImage(itemId, path)}
      />
    );
  } else {
    stage = (
      <SideStage
        label={before ? 'Before' : 'After'}
        image={(before ?? after)!}
        content={content}
        view={view}
        onView={onView}
        onFrameSize={onFrameSize}
        background={background}
      />
    );
  }

  return (
    <div className={'sw-image' + (card ? '' : ' is-fitting')} data-mode={mode}>
      <div className="sw-image-bar">
        <div className="sw-seg" role="group" aria-label="Compare mode (1–5)">
          {(compares ? IMAGE_MODES : SIDE_BY_SIDE_ONLY).map((option, i) => (
            <button
              key={option}
              type="button"
              className="sw-seg-btn"
              aria-pressed={mode === option}
              title={`${IMAGE_MODE_LABEL[option]} (${i + 1})`}
              onClick={() => setImageMode(itemId, path, option)}
            >
              {IMAGE_MODE_LABEL[option]}
            </button>
          ))}
        </div>
        <div className="sw-seg" role="group" aria-label="Background">
          {BACKGROUNDS.map(option => (
            <button
              key={option}
              type="button"
              className="sw-seg-btn"
              aria-pressed={background === option}
              onClick={() => setImageBackground(option)}
            >
              {IMAGE_BACKGROUND_LABEL[option]}
            </button>
          ))}
        </div>
        <span className="sw-image-meta" data-testid="image-meta">{meta}</span>
        {firstFrame && <span className="sw-image-note">{IMAGE_FIRST_FRAME}</span>}
      </div>
      {stage}
    </div>
  );
}
