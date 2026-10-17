/**
 * Loading an image card's two sides (#112, L1, L4, L5).
 *
 * Each side's bytes come from main through `sessionWorkImage`, become a blob
 * URL the card owns, and are decoded through an `<img>`, which is also the
 * only way an SVG is ever drawn: as an image, its scripts never run. The URLs
 * are revoked when the card goes or loads again. A side that main has no
 * bytes for, or that will not decode, fails the pair, and the card falls back
 * to its binary row.
 */
import { useEffect, useState } from 'react';
import type { FileDiff } from '../../../domain/session-work/model';
import type { ImageFormat } from '../../../domain/session-work/image';
import type { LoadedImage } from './image-compare/modes/types';
import type { Pixels } from './image-compare/types';

export type ImagePair =
  | { readonly phase: 'loading' }
  | { readonly phase: 'failed' }
  /** A side the file does not have (added, deleted) is null. */
  | { readonly phase: 'loaded'; readonly before: LoadedImage | null; readonly after: LoadedImage | null };

const LOADING: ImagePair = { phase: 'loading' };
const FAILED: ImagePair = { phase: 'failed' };

const MIME: Readonly<Record<ImageFormat, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
};

/** An SVG with no size of its own is drawn at a replaced element's default. */
const FALLBACK_SIZE = { width: 300, height: 150 };

/**
 * Both sides of `file`'s image, once `enabled`. Loads again when `loadKey`
 * (the item's diff as it was asked for) changes, since the bytes may have.
 */
export function useImagePair(
  sessionId: string, itemId: string, file: FileDiff, loadKey: string, enabled: boolean,
): ImagePair {
  const [pair, setPair] = useState<ImagePair>(LOADING);
  const image = file.image;
  const { path } = file;

  useEffect(() => {
    if (!enabled || !image) return;
    let live = true;
    const urls: string[] = [];
    setPair(LOADING);

    const load = async (side: 'before' | 'after'): Promise<LoadedImage | null> => {
      if (!image[side]) return null;
      const bytes = await window.api.sessionWorkImage({ sessionId, itemId, path, side });
      if (!bytes || !live) throw new Error('No image');
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: MIME[image.format] }));
      urls.push(url);
      return decodeImage(url, bytes, MIME[image.format]);
    };

    Promise.all([load('before'), load('after')]).then(
      ([before, after]) => { if (live) setPair({ phase: 'loaded', before, after }); },
      () => { if (live) setPair(FAILED); },
    );
    return () => {
      live = false;
      urls.forEach(url => URL.revokeObjectURL(url));
    };
  }, [sessionId, itemId, path, image, loadKey, enabled]);

  return pair;
}

async function decodeImage(url: string, bytes: Uint8Array, mime: string): Promise<LoadedImage> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const sized = img.naturalWidth > 0 && img.naturalHeight > 0;
  const width = sized ? img.naturalWidth : FALLBACK_SIZE.width;
  const height = sized ? img.naturalHeight : FALLBACK_SIZE.height;
  const animated = (await frameCount(bytes, mime)) > 1;

  let pixels: Pixels | null = null;
  return {
    url, width, height, animated,
    pixels() {
      if (!pixels) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context?.drawImage(img, 0, 0, width, height);
        pixels = context?.getImageData(0, 0, width, height) ?? { width, height, data: new Uint8ClampedArray(width * height * 4) };
      }
      return pixels;
    },
  };
}

/** The slice of WebCodecs' `ImageDecoder` this needs; not in every lib.dom. */
interface FrameDecoder {
  readonly tracks: { readonly ready: Promise<void>; readonly selectedTrack: { readonly frameCount: number } | null };
  close(): void;
}
interface FrameDecoderClass {
  new (init: { data: Uint8Array; type: string }): FrameDecoder;
  isTypeSupported(type: string): Promise<boolean>;
}

/** How many frames the image has, by `ImageDecoder` where there is one; 1 otherwise. */
async function frameCount(bytes: Uint8Array, mime: string): Promise<number> {
  const Decoder = (globalThis as { ImageDecoder?: FrameDecoderClass }).ImageDecoder;
  if (!Decoder || mime === MIME.svg) return 1;
  let decoder: FrameDecoder | null = null;
  try {
    if (!(await Decoder.isTypeSupported(mime))) return 1;
    decoder = new Decoder({ data: bytes, type: mime });
    await decoder.tracks.ready;
    return decoder.tracks.selectedTrack?.frameCount ?? 1;
  } catch {
    return 1;
  } finally {
    decoder?.close();
  }
}
