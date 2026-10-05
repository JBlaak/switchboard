/**
 * Physics-based motion, no library — the same engine BlaakTasks runs.
 *
 * Every animated value is a damped spring (unit mass) stepped at 240 Hz with
 * semi-implicit Euler, tuned by response (seconds: how quick) and damping ratio
 * (1 = no overshoot), which map to stiffness k = (2π/response)² and damping
 * c = 4πζ/response. Retargeting keeps the velocity, so interrupting a motion
 * mid-flight stays smooth. Under prefers-reduced-motion every spring is quick
 * and critically damped, and kicks do nothing.
 */
export const FEEL = { response: 0.34, damping: 0.78 } as const;
const REDUCED = { response: 0.22, damping: 1 } as const;
const STEP = 1 / 240;

const query = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : null;
let reduced = !!query?.matches;
query?.addEventListener('change', (e) => { reduced = e.matches; });

export const reducedMotion = (): boolean => reduced;
export const setReducedMotion = (on: boolean): void => { reduced = on; };

export interface SpringOptions {
  /** Multiplies the response: below 1 is snappier, above 1 lazier. */
  r?: number;
  /** A fixed damping ratio instead of the house one. */
  z?: number;
  /** A floor under the damping ratio: 1 keeps heights and exits from bouncing. */
  zMin?: number;
  /** Close enough to rest, in the value's own unit (default 0.01). */
  eps?: number;
}

const active = new Set<Spring>();
const hooks = new Set<(dt: number) => boolean>();
let raf = 0;
let last = 0;

export class Spring {
  public x: number;
  public v = 0;
  public target: number;
  public o: SpringOptions;
  public onUpdate?: (x: number) => void;
  public onRest?: () => void;

  public constructor(x = 0, o: SpringOptions = {}) {
    this.x = x;
    this.target = x;
    this.o = o;
  }

  public get moving(): boolean {
    return active.has(this);
  }

  public step(dt: number): void {
    const r = (reduced ? REDUCED.response : FEEL.response) * (this.o.r ?? 1);
    const z = reduced ? REDUCED.damping : (this.o.z ?? Math.max(this.o.zMin ?? 0, FEEL.damping));
    const k = ((2 * Math.PI) / r) ** 2;
    const c = (4 * Math.PI * z) / r;
    this.v += (-k * (this.x - this.target) - c * this.v) * dt;
    this.x += this.v * dt;
  }

  /** Spring towards a new target, keeping the current velocity. */
  public to(target: number): this {
    this.target = target;
    active.add(this);
    wake();
    return this;
  }

  /** Add velocity (units per second): a nudge that springs back. */
  public kick(velocity: number): this {
    if (!reduced) this.v += velocity;
    active.add(this);
    wake();
    return this;
  }

  /** Jump straight to a value and stop. */
  public set(x: number): this {
    this.x = this.target = x;
    this.v = 0;
    active.delete(this);
    this.onUpdate?.(x);
    flush();
    return this;
  }
}

/** Run every active spring and frame hook forward by dt seconds. The frame loop calls it; tests call it directly. */
export function advance(dt: number): void {
  for (const s of [...active]) {
    for (let t = dt; t > 1e-7; t -= STEP) s.step(Math.min(STEP, t));
    const eps = s.o.eps ?? 0.01;
    const rest = Math.abs(s.x - s.target) < eps && Math.abs(s.v) < eps * 20;
    if (rest) {
      s.x = s.target;
      s.v = 0;
      active.delete(s);
    }
    s.onUpdate?.(s.x);
    if (rest) s.onRest?.();
  }
  for (const h of [...hooks]) if (!h(dt)) hooks.delete(h);
  flush();
}

function tick(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  advance(dt);
  raf = active.size || hooks.size ? requestAnimationFrame(tick) : 0;
}

function wake(): void {
  if (raf || typeof requestAnimationFrame === 'undefined') return;
  last = performance.now();
  raf = requestAnimationFrame(tick);
}

/** Call fn every frame with the elapsed seconds until it returns false (particles). */
export function everyFrame(fn: (dt: number) => boolean): void {
  hooks.add(fn);
  wake();
}

/** An element's motion: translate x/y (px), scale, rotation (deg) and opacity, each a spring, written as one transform. */
export interface Motion {
  el: HTMLElement;
  x: Spring;
  y: Spring;
  s: Spring;
  r: Spring;
  o: Spring;
  /** Write opacity too (off by default, so CSS keeps it). */
  fade: boolean;
  /** Runs after every write: derived effects. */
  after?: (m: Motion) => void;
}

const motions = new WeakMap<Element, Motion>();
const dirty = new Set<Motion>();
let flushing = false;

export function motion(el: HTMLElement): Motion {
  const existing = motions.get(el);
  if (existing) return existing;
  const made: Motion = {
    el,
    x: new Spring(0, { eps: 0.1 }),
    y: new Spring(0, { eps: 0.1 }),
    s: new Spring(1, { eps: 0.0005 }),
    r: new Spring(0, { eps: 0.02 }),
    o: new Spring(1, { eps: 0.002, zMin: 1 }),
    fade: false,
  };
  for (const s of [made.x, made.y, made.s, made.r, made.o]) s.onUpdate = () => dirty.add(made);
  motions.set(el, made);
  return made;
}

export const hasMotion = (el: Element): Motion | undefined => motions.get(el);

/** The transform a motion writes right now, or '' at rest at identity. */
export function transformOf(m: Motion): string {
  const { x, y, s, r } = m;
  const idle = !x.moving && !y.moving && !s.moving && !r.moving
    && x.x === 0 && y.x === 0 && s.x === 1 && r.x === 0;
  return idle
    ? ''
    : `translate3d(${x.x.toFixed(2)}px, ${y.x.toFixed(2)}px, 0) rotate(${r.x.toFixed(2)}deg) scale(${s.x.toFixed(4)})`;
}

function flush(): void {
  if (flushing || typeof document === 'undefined') return;
  flushing = true;
  for (const m of dirty) {
    const style = m.el.style;
    // At rest at identity the inline transform goes, so no stray stacking context stays behind.
    style.transform = transformOf(m);
    if (m.fade) style.opacity = !m.o.moving && m.o.x === 1 ? '' : String(Math.min(1, Math.max(0, m.o.x)));
    m.after?.(m);
  }
  dirty.clear();
  flushing = false;
}
