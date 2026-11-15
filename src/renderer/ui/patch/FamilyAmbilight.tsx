/**
 * The family card's Ambilight (`domain/companion/ambilight`): light spilling
 * from the card's edges onto the app around it, behind the card.
 *
 * The bottom edge throws each floor figure's colour from under where it
 * stands, so it follows the managers as they are set up or not. The top edge
 * throws the sky's light, which the stylesheet picks by the scene's time of day
 * (`data-time` on the card). It breathes slowly; the stylesheet pauses it
 * with the other loops while the window is out of focus.
 */
import {bottomGlows} from '../../../domain/companion/ambilight';
import {managerFigureOf} from '../../state/inbox-slice';
import {useStore} from '../use-store';
import type {CSSProperties, JSX} from 'react';

export function FamilyAmbilight(): JSX.Element {
    const bug = useStore((state) => managerFigureOf(state.inbox, 'bug') !== null);
    const issue = useStore((state) => managerFigureOf(state.inbox, 'issue') !== null);
    return (
        <div className="placeholder-family-glow" aria-hidden="true" data-testid="family-ambilight">
            <div className="placeholder-family-glow-sky" />
            <div className="placeholder-family-glow-sun" />
            {bottomGlows({bug, issue}).map(({figure, x}) => (
                <div
                    key={figure}
                    className={`placeholder-family-glow-figure is-${figure}`}
                    style={{'--glow-x': `${x}px`} as CSSProperties}
                />
            ))}
        </div>
    );
}
