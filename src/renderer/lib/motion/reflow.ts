/**
 * Rows glide to their new place when a list changes (FLIP), as in BlaakTasks.
 *
 * Take a snapshot() of a list just before changing it and play() it straight
 * after: every element still there springs from where it was to where it is,
 * a new one fades in, and one that left is put back where it was, fixed, and
 * fades out. Positions are layout positions inside the scrolling container
 * (in-flight offsets taken out), so a change can land at any moment of a
 * running animation, or after a scroll, and it still adds up.
 *
 * Elements are matched by id, which is also what the sidebar's morph keys on.
 */
import { hasMotion, motion, reducedMotion, Spring, type Motion } from './spring';

/** More arrivals or departures than this in one change is a new screen (a filter, a search), not a change: nothing moves. */
const SCREEN_CHANGE = 12;

interface Pos { x: number; y: number; w: number; h: number }

export interface Snapshot {
  container: HTMLElement;
  selector: string;
  items: Map<string, { el: HTMLElement; pos: Pos }>;
}

/** Where an element sits in the container's scrolled content, without any motion it is in the middle of. */
function place(container: HTMLElement, el: HTMLElement): Pos {
  const c = container.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const m = hasMotion(el);
  return {
    x: r.left - c.left - (m ? m.x.x : 0),
    y: r.top - c.top + container.scrollTop - (m ? m.y.x : 0),
    w: r.width,
    h: r.height,
  };
}

function visible(el: HTMLElement): boolean {
  return el.offsetParent !== null && el.getClientRects().length > 0;
}

export function snapshot(container: HTMLElement, selector: string): Snapshot {
  const items = new Map<string, { el: HTMLElement; pos: Pos }>();
  for (const el of container.querySelectorAll<HTMLElement>(selector)) {
    if (el.id && visible(el)) items.set(el.id, { el, pos: place(container, el) });
  }
  return { container, selector, items };
}

/** Spring every element of the snapshot's list from where it was to where it is now. */
export function play(before: Snapshot): void {
  if (reducedMotion()) return;
  const { container, selector } = before;
  const now = [...container.querySelectorAll<HTMLElement>(selector)].filter(el => el.id && visible(el));
  const entering = now.filter(el => !before.items.has(el.id));
  const nowIds = new Set(now.map(el => el.id));
  const gone = [...before.items.values()].filter(({ el }) => !nowIds.has(el.id) || !el.isConnected);
  if (entering.length > SCREEN_CHANGE || gone.length > SCREEN_CHANGE) return;

  for (const el of now) {
    const was = before.items.get(el.id);
    const m = motion(el);
    if (!was) {
      enter(m);
      continue;
    }
    const pos = place(container, el);
    const dx = was.pos.x - pos.x;
    const dy = was.pos.y - pos.y;
    if (Math.abs(dx) + Math.abs(dy) < 0.5) continue;
    m.x.x += dx;
    m.y.x += dy;
    m.x.to(0);
    m.y.to(0);
  }
  for (const { el, pos } of gone) if (pos.h > 2) ghost(container, el, pos);
}

function enter(m: Motion): void {
  m.fade = true;
  m.o.set(0);
  m.s.set(0.96);
  m.y.set(-6);
  m.o.to(1);
  m.s.to(1);
  m.y.to(0);
}

/**
 * An element that left: a copy put back where it was, fixed over the page, that
 * fades out. A copy, because the morph may still own (or reuse) the original.
 */
function ghost(container: HTMLElement, el: HTMLElement, pos: Pos): void {
  const c = container.getBoundingClientRect();
  const copy = el.cloneNode(true) as HTMLElement;
  copy.removeAttribute('id');
  copy.classList.add('motion-ghost');
  copy.setAttribute('aria-hidden', 'true');
  Object.assign(copy.style, {
    position: 'fixed',
    left: `${c.left + pos.x}px`,
    top: `${c.top + pos.y - container.scrollTop}px`,
    width: `${pos.w}px`,
    height: `${pos.h}px`,
    margin: '0',
    pointerEvents: 'none',
    zIndex: '7',
    transform: '',
    opacity: '',
  });
  document.body.append(copy);
  const m = motion(copy);
  m.fade = true;
  m.o.onRest = () => copy.remove();
  m.o.to(0);
  m.s.to(0.96);
}

/** Close the gap an element leaves: its height springs to nothing, then `done`. */
export function collapse(el: HTMLElement, done?: () => void): void {
  if (reducedMotion()) {
    done?.();
    return;
  }
  const h = el.getBoundingClientRect().height;
  Object.assign(el.style, { overflow: 'hidden', minHeight: '0', boxSizing: 'border-box' });
  const s = new Spring(h, { eps: 0.3, zMin: 0.9 });
  s.onUpdate = (v) => { el.style.height = `${Math.max(0, v)}px`; };
  s.onRest = () => done?.();
  s.to(0);
}

/** Undo collapse() and any slide on an element that stayed (the action failed and it's back). */
export function uncollapse(el: HTMLElement): void {
  Object.assign(el.style, {
    overflow: '', minHeight: '', boxSizing: '', height: '', transform: '', opacity: '',
  });
  const m = motion(el);
  m.fade = false;
  for (const s of [m.x, m.y, m.r]) s.set(0);
  m.s.set(1);
  m.o.set(1);
}

/** A little scale bump (a pin that just went in, a badge that got one more). */
export function bump(el: Element | null, strength = 9): void {
  if (!(el instanceof HTMLElement)) return;
  motion(el).s.to(1).kick(strength);
}
