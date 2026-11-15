/**
 * The family card's Ambilight: light that spills from the card's edges onto
 * the app around it, like a TV against a wall.
 *
 * Along the bottom edge each figure on the floor throws its body colour,
 * straight below where it stands. Along the top the scene's sky throws its
 * light, and its colours are the stylesheet's, by the scene's time of day.
 *
 * Where the figures stand is the stylesheet's too (`_patch.scss`, the
 * managers' row); this mirrors it, so each colour lands under its figure.
 * Patch is the anchor: the managers stand a fixed step to either side.
 */

export type GlowFigure = 'bug' | 'patch' | 'issue' | 'merge';

/** One colour on the card's bottom edge: whose, and how far from the card's centre (px). */
export interface BottomGlow {
    figure: GlowFigure;
    x: number;
}

/** From one figure's centre to the next one's: a 92px gap plus half of each 150px manager. */
const STEP = 167;
/** From the Issue manager's centre to the Merge manager's after it. */
const MERGE_AFTER_ISSUE = 158;
/**
 * How far the row steps left to stay centred on the card, half a figure, unless
 * only the Bug manager and the Merge manager flank Patch, evenly.
 */
const ROW_SHIFT = -79;

/** The colours on the bottom edge, left to right, for the managers that stand there. */
export function bottomGlows(managers: {bug: boolean; issue: boolean}): BottomGlow[] {
    const shift = managers.bug && !managers.issue ? 0 : ROW_SHIFT;
    const glows: BottomGlow[] = [];
    if (managers.bug) glows.push({figure: 'bug', x: shift - STEP});
    glows.push({figure: 'patch', x: shift});
    if (managers.issue) glows.push({figure: 'issue', x: shift + STEP});
    glows.push({figure: 'merge', x: shift + STEP + (managers.issue ? MERGE_AFTER_ISSUE : 0)});
    return glows;
}
