/**
 * The Quick Ask pop-up's motion (#150, G4): Playful, growing from a drop.
 *
 * Ported from the motion prototype as it is, not through `lib/motion/spring`:
 * the prototype's springs are given as stiffness k and damping c at mass 1,
 * integrated in small fixed steps, one animation per channel, and starting a
 * channel again cancels what ran on it. The glass moves inside the still
 * window (G3), so everything here is the slab's inline width, height, scale
 * and opacity, and each write tells `onMove`, so the pass-through follows.
 *
 * Reduce motion turns every moment into a 120 ms fade, springs jumping to
 * their end. Under the e2e harness every moment jumps, fades too, so a
 * screenshot never lands mid-way.
 */

export interface SpringValues { readonly k: number; readonly c: number }

/** The Playful style's values (G4). */
export const PLAYFUL = {
  open: { k: 190, c: 13 },
  size: { k: 230, c: 17 },
  pulse: { k: 300, c: 8 },
  /** Back into the drop: the size spring, stiffer. */
  shrink: { k: 230 * 1.6, c: 17 * 1.3 },
  /** The mark's pulse is kicked with this velocity. */
  kick: 7,
  /** The drop holds this long before it stretches. */
  widenAfterMs: 90,
  /** The fade once it is back in the drop. */
  closeMs: 220,
} as const satisfies Record<string, SpringValues | number>;

/** Every moment, under Reduce motion. */
export const REDUCED_FADE_MS = 120;

/** `full`, the springs; `reduced`, 120 ms fades; `instant`, every moment at its end (e2e). */
export type MotionMode = 'full' | 'reduced' | 'instant';

/** Where frames come from: the browser's, or a test's. */
export interface Frames {
  now(): number;
  request(frame: (now: number) => void): number;
  cancel(id: number): void;
}

const browserFrames: Frames = {
  now: () => performance.now(),
  request: (frame) => requestAnimationFrame(frame),
  cancel: (id) => cancelAnimationFrame(id),
};

/** Steps per second, and the longest frame taken whole (a stall is not a leap). */
const STEPS_PER_SECOND = 480;
const LONGEST_FRAME = 0.064;

const clamp = (x: number, min = 0, max = 1): number => Math.min(max, Math.max(min, x));
const easeIn = (t: number): number => t * t * t;

/** The springs and fades running, one per channel. */
export class Channels {
  mode: MotionMode = 'full';
  readonly #frames: Frames;
  readonly #running = new Map<string, () => void>();

  constructor(frames: Frames = browserFrames) {
    this.#frames = frames;
  }

  /** A damped spring at mass 1 from `from` to `to`, starting with velocity `v0`. */
  spring(
    channel: string, from: number, to: number, { k, c }: SpringValues,
    onUpdate: (x: number) => void, onDone?: () => void, v0 = 0,
  ): void {
    this.stop(channel);
    if (this.mode !== 'full') { onUpdate(to); onDone?.(); return; }
    let x = from, v = v0, last = this.#frames.now(), id = 0, live = true;
    const range = Math.abs(to - from) || 1;
    const frame = (now: number): void => {
      if (!live) return;
      const dt = Math.min(LONGEST_FRAME, (now - last) / 1000);
      last = now;
      const steps = Math.max(1, Math.ceil(dt * STEPS_PER_SECOND)), h = dt / steps;
      for (let i = 0; i < steps; i++) {
        const a = -k * (x - to) - c * v;
        v += a * h;
        x += v * h;
      }
      if (Math.abs(x - to) < range * 0.001 && Math.abs(v) < range * 0.02) {
        this.#running.delete(channel);
        onUpdate(to);
        onDone?.();
        return;
      }
      onUpdate(x);
      id = this.#frames.request(frame);
    };
    id = this.#frames.request(frame);
    this.#running.set(channel, () => { live = false; this.#frames.cancel(id); });
  }

  /** `t` from 0 to 1 over `ms`, eased in; under Reduce motion, linear over 120 ms. */
  tween(channel: string, ms: number, onUpdate: (t: number) => void, onDone?: () => void): void {
    this.stop(channel);
    if (this.mode === 'instant') { onUpdate(1); onDone?.(); return; }
    const reduced = this.mode === 'reduced';
    const duration = reduced ? REDUCED_FADE_MS : ms;
    const start = this.#frames.now();
    let id = 0, live = true;
    const frame = (now: number): void => {
      if (!live) return;
      const t = clamp((now - start) / duration);
      onUpdate(reduced ? t : easeIn(t));
      if (t >= 1) { this.#running.delete(channel); onDone?.(); return; }
      id = this.#frames.request(frame);
    };
    id = this.#frames.request(frame);
    this.#running.set(channel, () => { live = false; this.#frames.cancel(id); });
  }

  moving(channel: string): boolean {
    return this.#running.has(channel);
  }

  /** Cancel what runs on `channel`, where it is; its `onDone` never comes. */
  stop(channel: string): void {
    this.#running.get(channel)?.();
    this.#running.delete(channel);
  }

  stopAll(): void {
    for (const channel of [...this.#running.keys()]) this.stop(channel);
  }
}

// ── The slab ──

/** The field row's height, and the drop's size: the row inside the 1 px rim. */
const ROW = 60;
const RIM = 1;
const DROP = ROW + 2 * RIM;
/** The slab at full width (B2). */
const FULL = 640;

type SlabPhase = 'hidden' | 'open' | 'closing';

/** What the slab looks like right now, as written to its style. */
interface Geometry { w: number; h: number; scale: number; opacity: number }

/**
 * The slab's choreography: opening from the drop, following its content,
 * the mark's pulse, and closing back into the drop. One for the pop-up, and
 * attached to its elements once they exist.
 */
export class SlabMotion {
  readonly channels = new Channels();
  /** Every write, so the pass-through can follow the slab (G3). */
  onMove: (() => void) | null = null;

  #slab: HTMLElement | null = null;
  #inner: HTMLElement | null = null;
  #mark: HTMLElement | null = null;
  #phase: SlabPhase = 'hidden';
  #g: Geometry = { w: DROP, h: DROP, scale: 0.5, opacity: 0 };
  #height = DROP;
  #widen: ReturnType<typeof setTimeout> | null = null;
  #follow: ResizeObserver | null = null;

  get closing(): boolean {
    return this.#phase === 'closing';
  }

  attach(slab: HTMLElement, inner: HTMLElement, mark: HTMLElement): () => void {
    this.#slab = slab;
    this.#inner = inner;
    this.#mark = mark;
    // The height follows the content: the choice list, a footer, the result line.
    this.#follow = new ResizeObserver(() => { if (this.#phase === 'open') this.#resize(this.#contentHeight()); });
    this.#follow.observe(inner);
    // Shown before it was drawn: it is simply there.
    if (this.#phase === 'open') {
      this.#height = this.#contentHeight();
      Object.assign(this.#g, { w: FULL, h: this.#height, scale: 1, opacity: 1 });
    }
    this.#apply();
    return () => {
      this.#follow?.disconnect();
      this.channels.stopAll();
      this.#slab = this.#inner = this.#mark = null;
    };
  }

  /** Taken each time the pop-up shows, so the system's settings apply from the next open. */
  setMode(mode: MotionMode): void {
    this.channels.mode = mode;
  }

  /** From the drop, or, caught closing, back from wherever it got to. */
  open(): void {
    const from = this.#phase;
    this.#phase = 'open';
    if (!this.#slab) return;
    this.#clearWiden();
    this.channels.stopAll();
    const content = this.#contentHeight();
    if (this.channels.mode !== 'full') {
      this.#collapse(false);
      Object.assign(this.#g, { w: FULL, h: content, scale: 1 });
      if (from === 'hidden') this.#g.opacity = 0;
      this.#height = content;
      const o0 = this.#g.opacity;
      this.channels.tween('fade', REDUCED_FADE_MS, (t) => { this.#g.opacity = o0 + (1 - o0) * t; this.#apply(); });
      return;
    }
    if (from === 'hidden') {
      Object.assign(this.#g, { w: DROP, h: DROP, scale: 0.5, opacity: 0 });
      this.#collapse(true);
    }
    this.#apply();
    const { scale: s0, opacity: o0 } = this.#g;
    this.channels.spring('open', 0, 1, PLAYFUL.open, (p) => {
      this.#g.scale = s0 + (1 - s0) * p;
      this.#g.opacity = o0 + (1 - o0) * clamp(p * 2.5);
      this.#apply();
    });
    const widen = (): void => {
      this.#widen = null;
      this.#resize(this.#contentHeight());
      this.channels.spring('width', this.#g.w, FULL, PLAYFUL.size, (x) => {
        this.#g.w = x;
        this.#apply();
        // The text comes in once the slab is past half its width.
        if (x > FULL * 0.55) this.#collapse(false);
      }, () => this.#collapse(false));
    };
    // Still a drop: it holds a moment first. Caught mid-close: straight back.
    if (this.#g.w <= DROP) this.#widen = setTimeout(widen, PLAYFUL.widenAfterMs);
    else widen();
  }

  /** Back into the drop, then a fade; `onHidden` once nothing shows. */
  close(onHidden: () => void): void {
    if (!this.#slab) { onHidden(); return; }
    if (this.#phase !== 'open') return;
    this.#phase = 'closing';
    this.#clearWiden();
    const finish = (): void => {
      this.channels.stopAll();
      this.#phase = 'hidden';
      this.#collapse(false);
      if (this.#mark) this.#mark.style.transform = '';
      onHidden();
    };
    if (this.channels.mode !== 'full') {
      const o0 = this.#g.opacity;
      this.channels.tween('fade', REDUCED_FADE_MS, (t) => { this.#g.opacity = o0 * (1 - t); this.#apply(); }, finish);
      return;
    }
    this.#collapse(true);
    this.channels.stop('open');
    this.#resize(DROP);
    this.channels.spring('width', this.#g.w, DROP, PLAYFUL.shrink, (x) => { this.#g.w = x; this.#apply(); }, () => {
      const { scale: s0, opacity: o0 } = this.#g;
      this.channels.tween('fade', PLAYFUL.closeMs, (t) => {
        this.#g.opacity = o0 * (1 - t);
        this.#g.scale = s0 - 0.4 * t;
        this.#apply();
      }, finish);
    });
  }

  /** The mark's pulse, as a result comes in. */
  pulse(): void {
    const mark = this.#mark;
    if (!mark) return;
    this.channels.spring('pulse', 1, 1, PLAYFUL.pulse, (x) => {
      mark.style.transform = x === 1 ? '' : `scale(${x.toFixed(4)})`;
    }, undefined, PLAYFUL.kick);
  }

  #resize(height: number): void {
    if (height === this.#height && (this.channels.moving('height') || this.#g.h === height)) return;
    this.#height = height;
    this.channels.spring('height', this.#g.h, height, PLAYFUL.size, (x) => { this.#g.h = x; this.#apply(); });
  }

  #contentHeight(): number {
    return (this.#inner?.offsetHeight ?? ROW) + 2 * RIM;
  }

  /** The text faded out, while the slab is a drop. */
  #collapse(on: boolean): void {
    this.#slab?.toggleAttribute('data-collapsed', on);
  }

  #clearWiden(): void {
    if (this.#widen !== null) clearTimeout(this.#widen);
    this.#widen = null;
  }

  #apply(): void {
    const slab = this.#slab;
    if (!slab) return;
    const { w, h, scale, opacity } = this.#g;
    slab.style.width = `${w}px`;
    slab.style.height = `${h}px`;
    slab.style.opacity = String(clamp(opacity));
    slab.style.transform = `translateX(-50%) scale(${scale})`;
    // Nothing to click while it is gone, or going.
    slab.style.pointerEvents = this.#phase === 'open' ? '' : 'none';
    this.onMove?.();
  }
}

/** The pop-up's one slab. */
export const slabMotion = new SlabMotion();
