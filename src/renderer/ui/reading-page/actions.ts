/**
 * The reading page's font choice: read from the stored `readingFont` setting
 * once at boot, and stored again whenever the page header's switch changes it.
 */
import {normaliseReadingFont} from '../../../domain/session/page-tool';
import {dispatch} from '../../state/app-store';
import type {ReadingFont} from '../../../domain/session/page-tool';

export const READING_FONT_SETTING = 'readingFont';

export function installReadingFont(): void {
    void window.api.getSetting(READING_FONT_SETTING).then((stored) => {
        dispatch({type: 'readingFontChanged', font: normaliseReadingFont(stored)});
    });
}

/** Shown at once; storing it only matters for the next launch. */
export function setReadingFont(font: ReadingFont): void {
    dispatch({type: 'readingFontChanged', font});
    void window.api.setSetting(READING_FONT_SETTING, font);
}
