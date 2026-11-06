/**
 * Patch, saying why 1Password is about to ask: the approved "1Password
 * heads-up" design.
 *
 * Patch holds what is wanted, keys for an SSH key or a padlock for a secret,
 * and speaks the headline; under it, Claude's own reason and the command.
 * Enter lets the command go ahead, and 1Password asks for Touch ID or the
 * password as it always does. Escape stops it: Patch puts the keys down for a
 * moment first, then the pop-up closes. Each heads-up is answered once; a
 * second key press before the next one shows does nothing.
 */
import {useEffect, useRef, useState} from 'react';
import {mountPatch} from '@jblaak/patch';
import '@jblaak/patch/patch.css';
import {headsUpCopy} from '../../domain/onepassword/heads-up';
import {timeOfDay} from '../../domain/companion/patch';
import type {JSX} from 'react';
import type {PatchHandle, PatchScene} from '@jblaak/patch';
import type {HeadsUpAnswer, HeadsUpShown, OnePasswordHeadsUp} from '../../ipc/heads-up-api';

/** How long Patch shows the keys put down before the pop-up closes on Escape. */
const KEYS_DOWN_MS = 650;

export function HeadsUp(): JSX.Element {
    const stage = useRef<HTMLDivElement>(null);
    const patch = useRef<PatchHandle | null>(null);
    const [shown, setShown] = useState<HeadsUpShown | null>(null);
    /** The id already answered, so a held Enter cannot answer the next heads-up too. */
    const answered = useRef<string | null>(null);

    useEffect(() => window.headsUp.onShown(setShown), []);

    useEffect(() => {
        if (!stage.current) return;
        const handle = mountPatch(stage.current);
        patch.current = handle;
        return () => {
            handle.destroy();
            patch.current = null;
        };
    }, []);

    const headsUp = shown?.headsUp ?? null;
    const reduceMotion = shown?.reduceMotion ?? false;

    useEffect(() => {
        if (!headsUp) return;
        answered.current = null;
        patch.current?.appear(scene(headsUp.need === 'access' ? 'padlock' : 'keys'));
    }, [headsUp]);

    useEffect(() => {
        if (!headsUp) return;
        const onKey = (event: KeyboardEvent): void => {
            if (event.key !== 'Enter' && event.key !== 'Escape') return;
            event.preventDefault();
            answer(event.key === 'Enter' ? 'go' : 'stop');
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    });

    function answer(choice: HeadsUpAnswer): void {
        if (!headsUp || answered.current === headsUp.id) return;
        answered.current = headsUp.id;
        if (choice === 'go') {
            window.headsUp.answer(headsUp.id, 'go');
            return;
        }
        // Not now: the keys go down, and then the pop-up goes. The command
        // waits that moment longer, which costs nothing: it will not run.
        patch.current?.appear(scene('keys-down'));
        const id = headsUp.id;
        setTimeout(() => window.headsUp.answer(id, 'stop'), reduceMotion ? 0 : KEYS_DOWN_MS);
    }

    const copy = headsUp ? headsUpCopy(headsUp) : null;
    return (
        <div className={'hu-card' + (headsUp ? ' is-shown' : '')} data-testid="heads-up" data-need={headsUp?.need}>
            <div className="hu-main">
                <div className="hu-stage" ref={stage} />
                <div className="hu-text">
                    <div className="hu-eyebrow">{copy?.eyebrow}</div>
                    <div className="hu-line">{copy?.line}</div>
                    <div className="hu-why" data-testid="heads-up-why">
                        {copy?.why}
                    </div>
                    <div className="hu-command" data-testid="heads-up-command" title={headsUp?.command}>
                        <span className="hu-prompt">$ </span>
                        {headsUp ? oneLine(headsUp) : ''}
                    </div>
                </div>
            </div>
            <div className="hu-footer">
                <div className="hu-then">{copy?.then}</div>
                <div className="hu-actions">
                    <button type="button" className="hu-stop" onClick={() => answer('stop')}>
                        Not now <kbd>esc</kbd>
                    </button>
                    <button type="button" className="hu-go" onClick={() => answer('go')}>
                        {copy?.goLabel} <kbd>⏎</kbd>
                    </button>
                </div>
            </div>
        </div>
    );
}

/** Patch holding `holding`, with no bubble: its line is the headline beside it. */
function scene(holding: PatchScene['holding']): PatchScene {
    return {move: 'hop', mood: 'calm', line: '', time: timeOfDay(new Date().getHours()), sky: null, holding};
}

/** A multi-line command on one line, so the box shows its start and ends in "…". */
function oneLine(headsUp: OnePasswordHeadsUp): string {
    return headsUp.command.replace(/\s*\n\s*/g, ' ');
}
