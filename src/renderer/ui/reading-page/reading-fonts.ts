/**
 * Atkinson Hyperlegible Next, the Braille Institute's typeface for low-vision
 * readers, as `@font-face` rules for the reading page's frame.
 *
 * The frame's CSP lets fonts in only as data: URLs, so the font files are
 * bundled as data URLs (esbuild's `dataurl` loader for .woff2) and written into
 * the frame's stylesheet. Latin and Latin Extended, upright and italic, each a
 * variable font covering weights 200 to 800.
 */
import latin from '@fontsource-variable/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-wght-normal.woff2';
import latinItalic from '@fontsource-variable/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-wght-italic.woff2';
import latinExt from '@fontsource-variable/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-ext-wght-normal.woff2';
import latinExtItalic from '@fontsource-variable/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-ext-wght-italic.woff2';
import {HYPERLEGIBLE_FAMILY} from '../../../domain/session/page-tool';

// Fontsource's ranges for the two subsets.
const LATIN =
    'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,' +
    'U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT =
    'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,' +
    'U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';

function face(url: string, style: 'normal' | 'italic', range: string): string {
    return (
        `@font-face { font-family: '${HYPERLEGIBLE_FAMILY}'; font-style: ${style}; font-display: block; ` +
        `font-weight: 200 800; src: url(${url}) format('woff2-variations'); unicode-range: ${range}; }\n`
    );
}

export const HYPERLEGIBLE_FONT_FACES =
    face(latinExt, 'normal', LATIN_EXT) +
    face(latin, 'normal', LATIN) +
    face(latinExtItalic, 'italic', LATIN_EXT) +
    face(latinItalic, 'italic', LATIN);
