/**
 * The rocket a Land it press launches, from the middle of the button, once
 * the PR is landed (#440). Designed in the artifact
 * https://claude.ai/artifact/651aRDJTBPoFHmoiaydbWY.
 *
 * Ignition: it rises out of the button and shakes on the pad while its flame
 * sputters and exhaust rolls out sideways. Lift-off: a shockwave ring, a
 * flash of glow and a burst of smoke and sparks. Climb: it speeds up on an
 * arc to the right, nose along its path, its flame stretching, smoke and
 * falling sparks behind it, until it leaves the top of the window with a
 * twinkle. Plain DOM on the spring loop plus the Web Animations API for the
 * particles, no library; skipped under prefers-reduced-motion, as the
 * confetti is.
 */
import {everyFrame, reducedMotion} from './spring';

/** The rocket's size, so it is placed by its middle. */
const WIDTH = 30;
const HEIGHT = 52;
const IGNITE_MS = 420;
const FLIGHT_MS = 1300;
/** How far it drifts right over the climb; the climb itself runs off the top of the window. */
const DRIFT_PX = 80;
const MIN_CLIMB_PX = 360;
/** How far above the button it settles on the pad before lift-off. */
const PAD_PX = 16;
/** Steepest lean, in radians. */
const MAX_LEAN = 0.5;

const ROCKET_SVG = `<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 30 52" fill="none" aria-hidden="true">
<defs>
<linearGradient id="rk-body" x1="0" x2="1"><stop offset="0" stop-color="#c9ccd2"/><stop offset=".35" stop-color="#ffffff"/><stop offset=".7" stop-color="#e4e6ea"/><stop offset="1" stop-color="#a9adb5"/></linearGradient>
<linearGradient id="rk-red" x1="0" x2="1"><stop offset="0" stop-color="#c2462f"/><stop offset=".4" stop-color="#ff7a5c"/><stop offset="1" stop-color="#a8371f"/></linearGradient>
<radialGradient id="rk-glass" cx=".35" cy=".35" r=".8"><stop offset="0" stop-color="#e6f4ff"/><stop offset=".45" stop-color="#7cb8e8"/><stop offset="1" stop-color="#2a5d8f"/></radialGradient>
</defs>
<path d="M6 30 L1 44 L1 47 L8 42 Z M24 30 L29 44 L29 47 L22 42 Z" fill="url(#rk-red)"/>
<path d="M15 1 C 24 9, 25 26, 22.5 42 H7.5 C 5 26, 6 9, 15 1 Z" fill="url(#rk-body)"/>
<path d="M15 1 C 20 5.5, 22.4 10.5, 23.3 15 H6.7 C 7.6 10.5, 10 5.5, 15 1 Z" fill="url(#rk-red)"/>
<path d="M6.7 15 H23.3" stroke="#8d929b" stroke-width=".8"/>
<circle cx="15" cy="23" r="4.6" fill="#7b8089"/>
<circle cx="15" cy="23" r="3.5" fill="url(#rk-glass)"/>
<path d="M13 21.4 a2.4 2.4 0 0 1 2.6 -0.9" stroke="#ffffff" stroke-width=".9" stroke-linecap="round" opacity=".9"/>
<path d="M15 33 V43" stroke="url(#rk-red)" stroke-width="3.2"/>
<path d="M9 42 H21 L19.5 46 H10.5 Z" fill="#5d626b"/>
</svg>`;

const clamp01 = (t: number): number => Math.min(1, Math.max(0, t));
const rnd = (a: number, b: number): number => a + Math.random() * (b - a);

/**
 * Where the rocket is a fraction `t` (0–1) into its climb, from the pad: it
 * rises slowly, then fast, curving right as it goes.
 */
export function rocketPath(t: number, climb = MIN_CLIMB_PX): {dx: number; dy: number} {
    const c = clamp01(t);
    return {dx: DRIFT_PX * Math.pow(c, 1.6), dy: -climb * Math.pow(c, 2.4)};
}

/** How far a rocket launched from height `y` climbs: off the top of the window. */
export function rocketClimb(y: number): number {
    return Math.max(MIN_CLIMB_PX, y + 140);
}

/** The lean, in radians clockwise, `t` into the climb: along the path, eased in, never past MAX_LEAN. */
export function rocketLean(t: number, climb = MIN_CLIMB_PX): number {
    const p = rocketPath(t, climb);
    const ahead = rocketPath(t + 0.02, climb);
    const up = p.dy - ahead.dy;
    const along = up > 0 ? Math.atan2(ahead.dx - p.dx, up) : 0;
    return Math.min(MAX_LEAN, along) * clamp01(t * 3);
}

/**
 * Where a Land it press launches its rocket: from `launchFrom`'s answer when
 * it is given, so none when it has nothing in sight, else from the button.
 */
export function rocketFrom(button: Element, launchFrom?: () => Element | null): Element | undefined {
    if (!launchFrom) return button;
    return launchFrom() ?? undefined;
}

function playOnce(el: HTMLElement, frames: Keyframe[], ms: number, easing = 'ease-out'): void {
    el.animate(frames, {duration: ms, easing, fill: 'forwards'}).onfinish = () => el.remove();
}

function add(layer: HTMLElement, cls: string): HTMLSpanElement {
    const el = document.createElement('span');
    el.className = cls;
    layer.appendChild(el);
    return el;
}

/** A puff of smoke at (x, y) that drifts by (vx, vy) as it swells and fades. */
function puff(layer: HTMLElement, x: number, y: number, vx: number, vy: number, size: number, ms: number): void {
    const s = size / 14;
    playOnce(
        add(layer, 'rocket-launch__puff'),
        [
            {transform: `translate(${x}px, ${y}px) scale(${s * 0.5})`, opacity: 0.95},
            {transform: `translate(${x + vx * 0.5}px, ${y + vy * 0.5}px) scale(${s * 1.5})`, opacity: 0.7, offset: 0.35},
            {transform: `translate(${x + vx}px, ${y + vy}px) scale(${s * 2.4})`, opacity: 0},
        ],
        ms,
        'cubic-bezier(.2, .7, .3, 1)',
    );
}

/** A spark at (x, y) that flies by (vx, vy), falls a little and burns out. */
function spark(layer: HTMLElement, x: number, y: number, vx: number, vy: number, ms: number): void {
    playOnce(
        add(layer, 'rocket-launch__spark'),
        [
            {transform: `translate(${x}px, ${y}px) scale(1)`, opacity: 1},
            {transform: `translate(${x + vx}px, ${y + vy + 30}px) scale(0.3)`, opacity: 0},
        ],
        ms,
        'cubic-bezier(.3, .6, .6, 1)',
    );
}

export function launchRocket(x: number, y: number): void {
    if (typeof window === 'undefined' || reducedMotion()) return;
    const layer = document.createElement('div');
    layer.className = 'rocket-launch';
    layer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(layer);

    const glow = document.createElement('div');
    glow.className = 'rocket-launch__glow';
    layer.appendChild(glow);
    const rocket = document.createElement('div');
    rocket.className = 'rocket-launch__rocket';
    rocket.innerHTML = ROCKET_SVG;
    const flame = document.createElement('div');
    flame.className = 'rocket-launch__flame';
    rocket.appendChild(flame);
    layer.appendChild(rocket);

    const climb = rocketClimb(y);
    const padY = y - PAD_PX;
    const baseY = padY + HEIGHT / 2;
    const place = (cx: number, cy: number, lean: number, scale: number, flameLong: number, flameWide: number): void => {
        rocket.style.transform = `translate(${cx - WIDTH / 2}px, ${cy - HEIGHT / 2}px) rotate(${lean}rad) scale(${scale})`;
        flame.style.transform = `scale(${flameWide}, ${flameLong})`;
    };
    place(x, y, 0, 0.3, 0.2, 0.6);
    glow.style.transform = `translate(${x}px, ${baseY}px) scale(0.2)`;

    const liftOff = (): void => {
        playOnce(
            add(layer, 'rocket-launch__ring'),
            [
                {transform: `translate(${x}px, ${baseY}px) scale(0.4)`, opacity: 1},
                {transform: `translate(${x}px, ${baseY}px) scale(5) scaleY(0.45)`, opacity: 0},
            ],
            650,
            'cubic-bezier(.1, .7, .3, 1)',
        );
        playOnce(
            glow,
            [
                {transform: `translate(${x}px, ${baseY}px) scale(0.9)`, opacity: 1},
                {transform: `translate(${x}px, ${baseY}px) scale(1.8)`, opacity: 0},
            ],
            500,
        );
        for (let i = 0; i < 10; i++) {
            puff(layer, x, baseY + 2, (i % 2 ? -1 : 1) * rnd(50, 130), rnd(-22, 6), rnd(14, 20), rnd(1000, 1500));
        }
        for (let i = 0; i < 8; i++) spark(layer, x, baseY, rnd(-60, 60), rnd(-10, 30), rnd(400, 700));
    };

    const twinkle = (): void => {
        const el = add(layer, 'rocket-launch__twinkle');
        el.textContent = '✦';
        const at = `translate(${x + DRIFT_PX - 9}px, 14px)`;
        playOnce(
            el,
            [
                {transform: `${at} scale(0) rotate(0deg)`, opacity: 0},
                {transform: `${at} scale(1.3) rotate(45deg)`, opacity: 1, offset: 0.35},
                {transform: `${at} scale(0) rotate(120deg)`, opacity: 0},
            ],
            600,
        );
    };

    let ms = 0;
    let lifted = false;
    let sinceSide = 0;
    let sinceTrail = 0;
    let sinceSpark = 0;
    everyFrame((dt) => {
        const step = dt * 1000;
        ms += step;
        if (ms < IGNITE_MS) {
            // Rise out of the button, settle on the pad, shake harder as thrust builds.
            const k = ms / IGNITE_MS;
            const rise = 1 - Math.pow(1 - Math.min(1, k * 2.2), 3);
            const shake = 0.6 + k * 1.6;
            const cx = x + rnd(-shake, shake);
            const cy = y - PAD_PX * rise + rnd(-shake, shake) * 0.5;
            place(cx, cy, rnd(-0.02, 0.02), 0.3 + 0.7 * rise, (0.25 + k * 0.45) * rnd(0.6, 1.2), rnd(0.85, 1.1));
            glow.style.transform = `translate(${x}px, ${baseY}px) scale(${0.3 + k * 0.6})`;
            glow.style.opacity = String(0.4 + k * 0.6);
            // Exhaust rolling out along the ground.
            sinceSide += step;
            if (k > 0.25 && sinceSide > 26) {
                sinceSide = 0;
                const dir = Math.random() < 0.5 ? -1 : 1;
                puff(layer, cx, baseY + 4, dir * rnd(40, 90), rnd(-14, 4), rnd(10, 16), rnd(900, 1300));
            }
            return true;
        }

        if (!lifted) {
            lifted = true;
            liftOff();
        }
        const t = (ms - IGNITE_MS) / FLIGHT_MS;
        if (t >= 1) {
            rocket.remove();
            twinkle();
            setTimeout(() => layer.remove(), 1600);
            return false;
        }
        const p = rocketPath(t, climb);
        const lean = rocketLean(t, climb);
        const scale = 1 - 0.18 * t;
        const cx = x + p.dx;
        const cy = padY + p.dy;
        place(cx, cy, lean, scale, (0.8 + Math.min(1.1, t * 1.6)) * rnd(0.85, 1.15), rnd(0.85, 1.05));
        // Smoke and sparks from the nozzle, wherever it now points.
        const nx = cx - Math.sin(lean) * (HEIGHT / 2 + 2) * scale;
        const ny = cy + Math.cos(lean) * (HEIGHT / 2 + 2) * scale;
        sinceTrail += step;
        if (sinceTrail > 16 && t < 0.95) {
            sinceTrail = 0;
            puff(layer, nx + rnd(-2, 2), ny, rnd(-14, 14) - Math.sin(lean) * 20, rnd(10, 30), rnd(9, 13) + t * 6, rnd(800, 1100));
        }
        sinceSpark += step;
        if (sinceSpark > 30 && t < 0.8) {
            sinceSpark = 0;
            spark(layer, nx, ny, rnd(-25, 25) - Math.sin(lean) * 40, rnd(30, 70), rnd(350, 600));
        }
        return true;
    });
}
