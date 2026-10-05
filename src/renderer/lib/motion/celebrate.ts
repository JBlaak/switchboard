/**
 * A burst of confetti, as BlaakTasks throws when a task is done.
 *
 * Particles with a launch velocity, gravity, air drag, a little flutter and
 * spin, run on the spring loop. Plain DOM, no library; skipped under
 * prefers-reduced-motion. Every fifth burst in a session is a bigger one.
 */
import { everyFrame, reducedMotion } from './spring';

const COLORS = ['#8fd8bf', '#1c6e56', '#9cc5e8', '#c8b8e8', '#eeab94', '#f5c86b'];
const SHAPES = ['', '', '', '★', '✦'];
const GRAVITY = 1500; // px/s²
let count = 0;

interface Particle {
  el: HTMLSpanElement;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  spin: number;
  t: number;
  life: number;
  phase: number;
  drag: number;
}

export function celebrate(x: number, y: number): void {
  if (typeof window === 'undefined' || reducedMotion()) return;
  const big = ++count % 5 === 0;
  const layer = document.createElement('div');
  layer.className = 'confetti';
  layer.setAttribute('aria-hidden', 'true');
  document.body.appendChild(layer);

  const parts: Particle[] = [];
  for (let i = 0; i < (big ? 70 : 28); i++) {
    const el = document.createElement('span');
    el.className = 'confetti__piece';
    const shape = SHAPES[Math.floor(Math.random() * SHAPES.length)];
    const color = COLORS[i % COLORS.length];
    el.textContent = shape;
    Object.assign(el.style, shape
      ? { color, fontSize: `${10 + Math.random() * 8}px` }
      : {
        background: color,
        width: `${5 + Math.random() * 5}px`,
        height: `${8 + Math.random() * 6}px`,
        borderRadius: Math.random() < 0.4 ? '50%' : '2px',
      });
    layer.appendChild(el);
    // Mostly upwards, fanning out; air drag slows them and gravity takes over.
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * (big ? 1.5 : 1.1);
    const speed = (big ? 420 : 300) + Math.random() * (big ? 520 : 320);
    parts.push({
      el, x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      rot: 0,
      spin: (Math.random() - 0.5) * 900,
      t: 0,
      life: 1.4 + Math.random() * 0.8,
      phase: Math.random() * 6,
      drag: 2.2 + Math.random() * 1.5,
    });
  }

  everyFrame((dt) => {
    let alive = 0;
    for (const p of parts) {
      if (p.t > p.life) continue;
      p.t += dt;
      p.vy += GRAVITY * dt;
      const d = Math.exp(-p.drag * dt);
      p.vx *= d;
      p.vy *= d;
      p.x += (p.vx + Math.sin(p.t * 9 + p.phase) * 40) * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
      p.el.style.transform = `translate3d(${p.x}px, ${p.y}px, 0) translate(-50%, -50%) rotate(${p.rot}deg) scaleX(${Math.cos(p.t * 7 + p.phase).toFixed(2)})`;
      p.el.style.opacity = String(Math.min(1, Math.max(0, (p.life - p.t) / 0.35)));
      if (p.t <= p.life) alive++;
    }
    if (!alive) layer.remove();
    return alive > 0;
  });
}
