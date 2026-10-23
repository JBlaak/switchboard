/**
 * Snoozing as falling asleep, as BlaakTasks snoozes a task.
 *
 * The moon nods off (tips over and rocks back), "z z Z" drift up from it with
 * a sway while a few stars twinkle around it, and the row dozes (dims and
 * sinks a little). Plain DOM on the spring loop, like the confetti; skipped
 * under prefers-reduced-motion.
 */
import { everyFrame, motion, reducedMotion } from './spring';

const NIGHT = 'var(--sb-lav-ink)';

/** How long the doze plays before the snooze is saved, so it is seen first. */
export const DOZE_MS = 420;

interface Mote {
  el: HTMLSpanElement;
  x: number;
  y: number;
  t: number;
  delay: number;
  life: number;
  kind: 'z' | 'star';
  dx: number;
  dy: number;
  phase: number;
}

/** Nod the moon off and doze its row. Answers how long to wait before saving: 0 when nothing plays. */
export function doze(moon: HTMLElement | null, row: HTMLElement | null): number {
  if (typeof window === 'undefined' || reducedMotion() || !moon) return 0;
  const r = moon.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;

  // The moon nods off: a quick tip, then it rocks back on a soft spring.
  const m = motion(moon);
  m.r.to(0).kick(-420);
  m.s.to(1).kick(6);

  const layer = document.createElement('div');
  layer.className = 'confetti';
  layer.setAttribute('aria-hidden', 'true');
  document.body.appendChild(layer);
  const motes: Mote[] = [];
  const add = (kind: Mote['kind'], text: string, size: number, delay: number, life: number, dx: number, dy: number): void => {
    const el = document.createElement('span');
    el.className = 'confetti__piece';
    el.textContent = text;
    Object.assign(el.style, { color: NIGHT, fontSize: `${size}px`, fontWeight: '800', opacity: '0' });
    layer.appendChild(el);
    motes.push({ el, x, y, t: 0, delay, life, kind, dx, dy, phase: Math.random() * 6 });
  };
  // Three z's, each later and bigger, rising up and to the right.
  add('z', 'z', 12, 0.05, 1.1, 10, -50);
  add('z', 'z', 16, 0.25, 1.2, 18, -72);
  add('z', 'Z', 21, 0.45, 1.3, 26, -96);
  // Stars twinkle in place around the moon.
  for (let i = 0; i < 4; i++) {
    const a = -Math.PI * (0.15 + 0.7 * Math.random());
    const d = 16 + Math.random() * 14;
    add('star', '✦', 7 + Math.random() * 5, 0.1 + i * 0.12, 0.7, Math.cos(a) * d, Math.sin(a) * d);
  }

  everyFrame((dt) => {
    let alive = 0;
    for (const mote of motes) {
      mote.t += dt;
      const t = mote.t - mote.delay;
      if (t > mote.life) continue;
      alive++;
      if (t < 0) continue;
      const k = t / mote.life; // 0 → 1 over its life
      if (mote.kind === 'z') {
        // Rises with an ease-out, sways side to side, grows a little, fades in quickly and out slowly.
        const rise = 1 - (1 - k) ** 2;
        const sway = Math.sin(t * 5 + mote.phase) * 4;
        const px = mote.x + mote.dx * rise + sway;
        const py = mote.y + mote.dy * rise;
        mote.el.style.transform = `translate3d(${px}px, ${py}px, 0) translate(-50%, -50%) rotate(${-12 + sway * 2}deg) scale(${0.7 + 0.4 * rise})`;
        mote.el.style.opacity = String(Math.min(1, t / 0.15) * Math.min(1, (mote.life - t) / 0.45));
      } else {
        // A twinkle: pops in, holds, shrinks away.
        const s = Math.sin(Math.PI * k);
        mote.el.style.transform = `translate3d(${mote.x + mote.dx}px, ${mote.y + mote.dy}px, 0) translate(-50%, -50%) scale(${s}) rotate(${k * 90}deg)`;
        mote.el.style.opacity = String(s);
      }
    }
    if (!alive) layer.remove();
    return alive > 0;
  });

  // The row dozes: dims and sinks a touch. If it is still listed after the save (a search lists snoozed rows), it wakes.
  if (row) {
    const rm = motion(row);
    rm.fade = true;
    rm.o.to(0.5);
    rm.y.to(3);
    setTimeout(() => {
      if (row.isConnected && !row.hasAttribute('data-leaving')) {
        rm.o.to(1);
        rm.y.to(0);
      }
    }, 1200);
  }
  return DOZE_MS;
}

/** Waking a snoozed row: the moon hops up. */
export function wakeUp(moon: HTMLElement | null): void {
  if (!moon || reducedMotion()) return;
  const m = motion(moon);
  m.y.to(0).kick(-160);
  m.s.to(1).kick(8);
}
