/**
 * The slim strip under the session header while the session on screen is an
 * errand: its kind and "Errand for the Merge manager · fixing checks on #431 ·
 * archives itself", so a session the user did not start says so where they
 * look first.
 *
 * It renders into `#terminal-errand-strip`, above `#terminal-queue-panel`,
 * and shows and hides that container itself; the terminal is refitted
 * whenever it does, since the strip takes its height from the terminal's.
 */
import {useLayoutEffect} from 'react';
import type {JSX} from 'react';
import {errandHeaderText, type ErrandEntry} from '../../../domain/session/errand-shelf';
import {errandOf} from '../../state/errand-index';
import {refitOpenTerminals} from '../../features/terminal/terminal-manager';
import {useStore} from '../use-store';
import {ErrandGlyph} from '../session-list/ErrandGlyph';

export function ErrandStrip(): JSX.Element | null {
    const errand = useStore((state) => (state.terminal.onScreen ? errandOf(state, state.terminal.onScreen) : null));
    const shown = errand !== null;

    useLayoutEffect(() => {
        const container = document.getElementById('terminal-errand-strip');
        if (!container || container.hidden === !shown) return;
        container.hidden = !shown;
        refitOpenTerminals();
    }, [shown]);

    return errand && <ErrandStripContent errand={errand} />;
}

/** The strip's markup: "Errand" in bold, the rest of the sentence muted. */
export function ErrandStripContent({errand}: {errand: ErrandEntry}): JSX.Element {
    const text = errandHeaderText(errand);
    const lead = 'Errand';
    return (
        <div className={'errand-strip' + (errand.needsYou ? ' needs-you' : '')} data-testid="errand-strip" role="note">
            <ErrandGlyph kind={errand.kind} className="errand-strip-glyph" />
            <span className="errand-strip-text">
                {text.startsWith(lead) ? (
                    <>
                        <strong>{lead}</strong>
                        {text.slice(lead.length)}
                    </>
                ) : (
                    text
                )}
            </span>
        </div>
    );
}
