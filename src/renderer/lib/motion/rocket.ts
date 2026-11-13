/**
 * A small rocket with a smoke trail (#440): what archiving a landed session
 * launches instead of confetti, from the same spot (the row's centre).
 *
 * It pops up a little, then climbs away, leaning right as it speeds up, and
 * leaves puffs of smoke that swell and fade along its path. Plain DOM and the
 * Web Animations API, no library; skipped under prefers-reduced-motion, as
 * the confetti is.
 */
import {reducedMotion} from './spring';

/** How far the rocket climbs, and drifts right, before it is gone. */
const CLIMB_PX = 360;
const DRIFT_PX = 30;
const FLIGHT_MS = 1400;
const PUFFS = 14;
const PUFF_EVERY_MS = 70;
const PUFF_MS = 900;
/** The rocket's size, so it is launched from its middle. */
const WIDTH = 34;
const HEIGHT = 54;

const ROCKET_SVG = `<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 34 54" fill="none" aria-hidden="true">
<path d="M17 2 C 27 12, 28 28, 25 38 H9 C 6 28, 7 12, 17 2 Z" fill="#ecebe8"/>
<circle cx="17" cy="20" r="5" fill="#9cc5e8" stroke="#2b2c30" stroke-width="2"/>
<path d="M9 30 L2 42 L9 40 Z M25 30 L32 42 L25 40 Z" fill="#9cc5e8"/>
<path d="M11 38 Q17 54 23 38 Z" fill="#f39a3c"/>
<path d="M14 38 Q17 48 20 38 Z" fill="#ffd27a"/>
</svg>`;

/** Where the rocket is a fraction `t` (0–1) into its climb, from where it took off: the path the smoke follows. */
export function rocketPath(t: number): {dx: number; dy: number} {
    const eased = Math.pow(Math.min(1, Math.max(0, t)), 2.2);
    return {dx: DRIFT_PX * eased, dy: -CLIMB_PX * eased};
}

export function launchRocket(x: number, y: number): void {
    if (typeof window === 'undefined' || reducedMotion()) return;
    const layer = document.createElement('div');
    layer.className = 'rocket-launch';
    layer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(layer);

    const rocket = document.createElement('div');
    rocket.className = 'rocket-launch__rocket';
    rocket.innerHTML = ROCKET_SVG;
    Object.assign(rocket.style, {left: `${x - WIDTH / 2}px`, top: `${y - HEIGHT / 2}px`});
    layer.appendChild(rocket);
    rocket.animate(
        [
            {transform: 'translate(0, 0) scale(0.6)'},
            {transform: 'translate(0, -10px) scale(1)', offset: 0.15},
            {transform: `translate(${DRIFT_PX}px, ${-CLIMB_PX}px) rotate(8deg) scale(0.8)`},
        ],
        {duration: FLIGHT_MS, easing: 'cubic-bezier(.5, 0, .8, .4)', fill: 'forwards'},
    );

    for (let i = 0; i < PUFFS; i++) {
        setTimeout(() => {
            const {dx, dy} = rocketPath(i / PUFFS);
            const puff = document.createElement('span');
            puff.className = 'rocket-launch__puff';
            Object.assign(puff.style, {left: `${x - 5 + dx}px`, top: `${y + 20 + dy}px`});
            layer.appendChild(puff);
            puff.animate(
                [
                    {transform: 'scale(0.6)', opacity: 0.9},
                    {transform: `scale(${2 + Math.random()}) translateY(8px)`, opacity: 0},
                ],
                {duration: PUFF_MS, fill: 'forwards'},
            );
        }, i * PUFF_EVERY_MS);
    }

    setTimeout(() => layer.remove(), Math.max(FLIGHT_MS, PUFFS * PUFF_EVERY_MS + PUFF_MS) + 100);
}
