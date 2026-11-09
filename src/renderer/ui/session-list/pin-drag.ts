/**
 * Dragging a pinned entry into its place (#379).
 *
 * A press on a pinned session, a pinned group, a pinned project or a pinned
 * plan that travels past the slop is a drag: the entry lifts and follows the
 * pointer up and down its own section, and the entries it passes slide out of
 * its way, so the gap it would drop into is always open. Letting go glides it
 * into that gap and stores the new order (`movePins`); the list's redraw then
 * takes every entry over from where it is on screen (`use-reflow`), so nothing
 * jumps. It never leaves its section, and Esc, a cancelled pointer or the
 * window losing focus put everything back. The click that ends a drag that
 * moved something is swallowed, so a drop never opens what was dragged; a
 * press that comes up before travelling is still the click that opens it.
 *
 * Which entries move, and what a move asks main for, is `state/pin-moves`';
 * this owns the listeners and the motion. One listener on the list serves
 * every entry, as the entries come and go with each layout.
 */
import {getState} from '../../state/app-store';
import {dropSlot, makeRoom, pinMove, pinnedSectionOf} from '../../state/pin-moves';
import {motion, reducedMotion} from '../../lib/motion/spring';
import {movePins} from './actions';
import type {PinnedSection} from '../../state/pin-moves';

/** Presses that start on these belong to them, not to the entry. */
const OWN_PRESSES = 'button, input, textarea, .session-pin, .session-actions';

/** How far, in px, a press travels before it is a drag rather than a click. */
const DRAG_SLOP_PX = 5;

/** How much a lifted entry grows. */
const LIFT_SCALE = 1.02;

/** Long enough after a stored move for its redraw to have taken the entries over. */
const REDRAW_MS = 150;

interface Drag {
    readonly el: HTMLElement;
    readonly found: PinnedSection;
    /** Every entry of the section, top to bottom, the dragged one included. */
    readonly entries: readonly HTMLElement[];
    /** How far below the entry's top the pointer holds it. */
    readonly grab: number;
    slot: number;
}

/** Where the entries sit in the layout, on screen: without whatever they are gliding by. */
interface Placed {
    readonly tops: readonly number[];
    readonly bottoms: readonly number[];
}

/** Watch the list in `container` for drags of pinned entries; answers the call that stops watching. */
export function installPinDrag(container: HTMLElement): () => void {
    let pressed: {el: HTMLElement; entryId: string; x: number; y: number} | null = null;
    let drag: Drag | null = null;
    let lastY = 0;

    const onMove = (e: PointerEvent): void => {
        lastY = e.clientY;
        if (drag) {
            follow(drag, lastY);
            return;
        }
        if (!pressed || Math.hypot(e.clientX - pressed.x, e.clientY - pressed.y) <= DRAG_SLOP_PX) return;
        drag = lift(pressed.el, pressed.entryId, pressed.y);
        // Nothing in the section to move past: the press is just a press.
        if (!drag) end();
        else follow(drag, lastY);
    };
    const onUp = (): void => {
        const done = drag;
        end();
        // A drag that put the entry back where it was is a wobbly click: let it open the row.
        if (done && drop(done)) swallowNextClick();
    };
    const onCancel = (): void => {
        const done = drag;
        end();
        if (done) settle(done);
    };
    const onKey = (e: KeyboardEvent): void => {
        if (e.key !== 'Escape' || !drag) return;
        e.preventDefault();
        e.stopPropagation();
        onCancel();
    };
    // The list scrolling under a still pointer moves the slots past the entry.
    const onScroll = (): void => {
        if (drag) follow(drag, lastY);
    };

    const listen = (): void => {
        window.addEventListener('pointermove', onMove, true);
        window.addEventListener('pointerup', onUp, true);
        window.addEventListener('pointercancel', onCancel, true);
        window.addEventListener('keydown', onKey, true);
        window.addEventListener('blur', onCancel);
        container.addEventListener('scroll', onScroll);
    };
    const unlisten = (): void => {
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        window.removeEventListener('pointercancel', onCancel, true);
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('blur', onCancel);
        container.removeEventListener('scroll', onScroll);
    };

    const end = (): void => {
        unlisten();
        pressed = null;
        drag = null;
    };

    const onDown = (e: PointerEvent): void => {
        if (e.button !== 0 || pressed || drag) return;
        const target = e.target as Element;
        if (target.closest(OWN_PRESSES)) return;
        const found = pinnedEntryAt(container, target);
        if (!found) return;
        pressed = {...found, x: e.clientX, y: e.clientY};
        lastY = e.clientY;
        listen();
    };

    container.addEventListener('pointerdown', onDown);
    return () => {
        if (drag) settle(drag);
        end();
        container.removeEventListener('pointerdown', onDown);
    };
}

/**
 * The pinned top-level entry a press at `target` is on, if it is in a
 * pinned section of the unfiltered list and not on its way out.
 */
function pinnedEntryAt(container: HTMLElement, target: Element): {el: HTMLElement; entryId: string} | null {
    const layout = getState().sessionList.layout;
    if (!layout || layout.filtering) return null;
    for (let el = target.closest<HTMLElement>('[id]'); el && el !== container;) {
        if (el.dataset.leaving !== undefined) return null;
        if (pinnedSectionOf(layout, el.id)) return {el, entryId: el.id};
        el = el.parentElement?.closest<HTMLElement>('[id]') ?? null;
    }
    return null;
}

/** Lift the entry off its section; null when there is nothing in the section to move it past. */
function lift(el: HTMLElement, entryId: string, originY: number): Drag | null {
    const found = pinnedSectionOf(getState().sessionList.layout, entryId);
    if (!found || found.entries.length < 2) return null;
    const elements = found.entries.map((laid) => document.getElementById(laid.entry.id));
    if (elements.some((e) => !e)) return null;
    const entries = elements as HTMLElement[];

    el.classList.add('is-pin-dragging');
    document.body.classList.add('is-pin-dragging');
    motion(el).s.to(LIFT_SCALE);
    return {el, found, entries, grab: originY - placed(entries).tops[found.index], slot: found.index};
}

/**
 * Where the entries sit, measured afresh each time: a redraw or a scroll in
 * the middle of a drag moves them, and the drag carries on from there.
 */
function placed(entries: readonly HTMLElement[]): Placed {
    const rects = entries.map((e) => {
        const r = e.getBoundingClientRect();
        const dy = motion(e).y.x;
        return {top: r.top - dy, bottom: r.bottom - dy};
    });
    return {tops: rects.map((r) => r.top), bottoms: rects.map((r) => r.bottom)};
}

/** The entry follows the pointer, inside its section, and the others make room where it would land. */
function follow(drag: Drag, y: number): void {
    const i = drag.found.index;
    const {tops, bottoms} = placed(drag.entries);
    const height = bottoms[i] - tops[i];
    const wanted = y - drag.grab;
    const top = Math.min(bottoms[bottoms.length - 1] - height, Math.max(tops[0], wanted));
    motion(drag.el).y.set(top - tops[i]);

    // Where the pointer would put it, not where it stops: held against an end of
    // the section, its middle only just meets the end entry's.
    const middles = tops.map((t, n) => (t + bottoms[n]) / 2);
    drag.slot = dropSlot(
        middles.filter((_, n) => n !== i),
        wanted + height / 2,
    );
    // An entry it passes moves by its height and the gap after it.
    const stride = i < tops.length - 1 ? tops[i + 1] - tops[i] : bottoms[i] - bottoms[i - 1];
    drag.entries.forEach((other, n) => {
        if (n === i) return;
        const m = motion(other);
        const room = makeRoom(n, i, drag.slot, stride);
        if (m.y.target === room) return;
        if (reducedMotion()) m.y.set(room);
        else m.y.to(room);
    });
}

/** Where, from its own place, the dragged entry lands in `slot`. */
function landing({entries, found}: Drag, slot: number): number {
    const {tops, bottoms} = placed(entries);
    const i = found.index;
    if (slot < i) return tops[slot] - tops[i];
    if (slot > i) return bottoms[slot] - bottoms[i];
    return 0;
}

/**
 * Let go: glide the entry into its gap and store the move. The redraw that
 * follows takes every entry over from where it is, so the list stays put on
 * screen; should the move fail, everything goes back. Answers whether
 * anything moved.
 */
function drop(drag: Drag): boolean {
    const move = sectionUnchanged(drag) ? pinMove(drag.found.entries, drag.found.index, drag.slot) : null;
    if (!move) {
        settle(drag);
        return false;
    }
    putDown(drag, landing(drag, drag.slot));
    void movePins(drag.found.section, move).then(
        // The redraw glides every entry home, and any it did not reach (a hidden list) goes after it.
        // Under reduced motion nothing glides: the entries jump to their places with the redraw.
        () => (reducedMotion() ? home(drag) : window.setTimeout(() => home(drag), REDRAW_MS)),
        () => home(drag),
    );
    return true;
}

/** Whether the section still holds what it held at the lift: a pin that came or went meanwhile voids the drag. */
function sectionUnchanged({el, found}: Drag): boolean {
    const now = pinnedSectionOf(getState().sessionList.layout, el.id);
    const ids = (section: PinnedSection): string => section.entries.map((laid) => laid.entry.id).join('\n');
    return !!now && now.section === found.section && ids(now) === ids(found);
}

/** Put everything back where the layout has it. */
function settle(drag: Drag): void {
    putDown(drag, 0);
    home(drag);
}

/** Lower the dragged entry onto `y`; it rides above the others until it gets there. */
function putDown({el}: Drag, y: number): void {
    document.body.classList.remove('is-pin-dragging');
    const m = motion(el);
    const landed = (): void => {
        m.y.onRest = undefined;
        el.classList.remove('is-pin-dragging');
    };
    if (reducedMotion()) {
        m.y.set(y);
        m.s.set(1);
        landed();
        return;
    }
    m.y.onRest = landed;
    m.y.to(y);
    m.s.to(1);
}

/** Every entry of the section springs to its own place in the layout. */
function home({entries}: Drag): void {
    for (const e of entries) {
        const m = motion(e);
        if (m.y.target === 0 && m.y.x === 0) continue;
        if (reducedMotion()) m.y.set(0);
        else m.y.to(0);
    }
}

/** The click the release makes comes straight after it; kept no longer, so no later click is eaten. */
function swallowNextClick(): void {
    const swallow = (e: MouseEvent): void => {
        e.stopPropagation();
        e.preventDefault();
    };
    window.addEventListener('click', swallow, true);
    window.setTimeout(() => window.removeEventListener('click', swallow, true), 0);
}
