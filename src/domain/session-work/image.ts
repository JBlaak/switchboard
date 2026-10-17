/**
 * Which files in a diff are images, and where each side of one is read from.
 *
 * An image in a diff is a binary row with nothing to look at (or, for SVG, a
 * line diff of markup). The page compares the two versions instead (#112), and
 * these rules decide which files get that card and which path each side is
 * read at. Only a local diff has the bytes to hand; GitHub's copy does not (I4).
 */
import type { FileDiff } from './model';

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'avif' | 'bmp' | 'ico' | 'svg';

/** Images up to this size on both sides load as soon as their card shows (L1); bigger ones wait for Show diff. */
export const IMAGE_AUTO_LOAD_BYTES = 5 * 1024 * 1024;

const FORMATS: Record<string, ImageFormat> = {
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  gif: 'gif',
  webp: 'webp',
  avif: 'avif',
  bmp: 'bmp',
  ico: 'ico',
  svg: 'svg',
};

/** The image format a path names by its extension, in any case; null when it is not an image (I3). */
export function imageFormatOf(path: string): ImageFormat | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  return FORMATS[name.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * The path each side of a file is read at: a renamed or copied file's before
 * is its old path. An added file has no before, a deleted one no after (I5).
 */
export function imagePaths(file: Pick<FileDiff, 'path' | 'oldPath' | 'status'>): { before: string | null; after: string | null } {
  return {
    before: file.status === 'added' ? null : file.oldPath ?? file.path,
    after: file.status === 'deleted' ? null : file.path,
  };
}
