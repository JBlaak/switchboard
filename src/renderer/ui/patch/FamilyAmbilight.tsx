/**
 * The family card's Ambilight (`domain/companion/ambilight`): light spilling
 * from the card's edges onto the app around it, behind the card.
 *
 * It is drawn like a real Ambilight: a picture of what is on the card's
 * edges, blurred out past them. The top edge is the scene's sky and its sun
 * or moon, which the stylesheet picks by the scene's time of day (`data-time`
 * on the card). The bottom edge has each floor figure's colour under where it
 * stands, so it follows the managers as they are set up or not. The picture
 * is drawn twice: a tight, bright rim along the edge and a wide, soft spill
 * further out. It breathes slowly; the stylesheet pauses it with the other
 * loops while the window is out of focus.
 */
import {bottomGlows, type BottomGlow} from '../../../domain/companion/ambilight';
import {managerFigureOf} from '../../state/inbox-slice';
import {useStore} from '../use-store';
import type {CSSProperties, JSX} from 'react';

export function FamilyAmbilight(): JSX.Element {
    const bug = useStore((state) => managerFigureOf(state.inbox, 'bug') !== null);
    const issue = useStore((state) => managerFigureOf(state.inbox, 'issue') !== null);
    const glows = bottomGlows({bug, issue});
    return (
        <div className="placeholder-family-glow" aria-hidden="true" data-testid="family-ambilight">
            <EdgePicture layer="wide" glows={glows} />
            <EdgePicture layer="rim" glows={glows} />
        </div>
    );
}

/** What is on the card's edges, for one layer of the light to blur. */
function EdgePicture({layer, glows}: {layer: 'wide' | 'rim'; glows: BottomGlow[]}): JSX.Element {
    return (
        <div className={`placeholder-family-glow-layer is-${layer}`}>
            <div className="placeholder-family-glow-sun" />
            {glows.map(({figure, x}) => (
                <div
                    key={figure}
                    className={`placeholder-family-glow-figure is-${figure}`}
                    style={{'--glow-x': `${x}px`} as CSSProperties}
                />
            ))}
        </div>
    );
}
