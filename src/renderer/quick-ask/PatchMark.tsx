/**
 * Patch as the Quick Ask mark: Patch's own body, filled with the rim's aurora,
 * and a face that follows the phase (`patchMarkFace`). The shapes are Patch's,
 * from `@jblaak/patch`'s art, in its 200-wide drawing's coordinates, cropped
 * to the body; the eyes are drawn a little larger so they read at 28 px.
 */
import {patchMarkFace} from './patch-mark';
import type {JSX} from 'react';
import type {QuickAskPhase} from '../state/quick-ask-slice';

const BODY =
    'M50 138 C 46 96, 72 68, 100 68 C 132 68, 152 96, 148 138 C 146 158, 128 166, 100 166 C 70 166, 52 158, 50 138 Z';

export function PatchMark({phase}: {phase: QuickAskPhase}): JSX.Element {
    const face = patchMarkFace(phase);
    return (
        <svg className={'quick-ask-patch is-' + face} viewBox="44 60 112 112" aria-hidden="true">
            <defs>
                <linearGradient id="quick-ask-aurora" x1="0" y1="0" x2="1" y2="1">
                    <stop className="quick-ask-patch-stop-a" offset="0" />
                    <stop className="quick-ask-patch-stop-b" offset="0.45" />
                    <stop className="quick-ask-patch-stop-c" offset="1" />
                </linearGradient>
            </defs>
            <path className="quick-ask-patch-body" d={BODY} />
            <ellipse className="quick-ask-patch-shine" cx="74" cy="88" rx="9" ry="5" transform="rotate(-30 74 88)" />
            <PatchFace face={face} />
        </svg>
    );
}

function PatchFace({face}: {face: ReturnType<typeof patchMarkFace>}): JSX.Element {
    switch (face) {
        case 'smile':
            return (
                <g className="quick-ask-patch-face">
                    <ellipse cx="86" cy="118" rx="6.5" ry="9" />
                    <ellipse cx="114" cy="118" rx="6.5" ry="9" />
                    <path className="is-line" d="M92 138 Q100 145 108 138" />
                </g>
            );
        case 'thinking':
            return (
                <g className="quick-ask-patch-face">
                    <ellipse cx="91" cy="110" rx="6.5" ry="9" />
                    <ellipse cx="119" cy="110" rx="6.5" ry="9" />
                    <ellipse cx="104" cy="141" rx="4" ry="4.5" />
                </g>
            );
        case 'unsure':
            return (
                <g className="quick-ask-patch-face">
                    <ellipse cx="84" cy="124" rx="6.5" ry="8" />
                    <ellipse cx="112" cy="124" rx="6.5" ry="8" />
                    <path className="is-line" d="M93 143 L107 143" />
                </g>
            );
        case 'happy':
            return (
                <g className="quick-ask-patch-face">
                    <path className="is-line is-bold" d="M79 122 Q86 110 93 122" />
                    <path className="is-line is-bold" d="M107 122 Q114 110 121 122" />
                    <path className="is-line" d="M90 136 Q100 148 110 136" />
                </g>
            );
    }
}
