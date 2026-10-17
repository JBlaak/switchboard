/**
 * The sidebar's blank space below the sessions: a click puts the session away,
 * a drag moves the window.
 *
 * It cannot be a CSS drag region, which macOS treats as title bar and never
 * hands the page a click. So a press is watched here instead: one that comes
 * up where it went down is left to be the click it already is (heard by the
 * list's own click listener, see `clearScreenFromList`), and one that travels
 * moves the window from main and swallows the click that follows it.
 */

/** How far a press travels, in px, before it is a drag rather than a click. */
const DRAG_THRESHOLD_PX = 4;

/** Watch `space` for drags; answers the call that stops watching. */
export function installDragSpace(space: HTMLElement): () => void {
  let press: { id: number; screenX: number; screenY: number; dragging: boolean } | null = null;
  let swallowClick = false;
  let frame = 0;
  let pending: { dx: number; dy: number } | null = null;

  const flush = (): void => {
    frame = 0;
    if (pending) window.api.moveWindowDrag(pending.dx, pending.dy);
    pending = null;
  };

  const finish = (): void => {
    if (press?.dragging) {
      if (frame) cancelAnimationFrame(frame);
      flush();
      window.api.endWindowDrag();
      swallowClick = true;
    }
    press = null;
  };

  const onDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    press = { id: e.pointerId, screenX: e.screenX, screenY: e.screenY, dragging: false };
    swallowClick = false;
    // Keeps the moves coming once the pointer leaves the window, as it will
    // the moment the window lags a fast drag. Refused for a pointer that is
    // not really down, which only a synthetic event can be.
    try { space.setPointerCapture(e.pointerId); } catch { /* moves still arrive while over the space */ }
  };

  const onMove = (e: PointerEvent): void => {
    if (!press || e.pointerId !== press.id) return;
    const dx = e.screenX - press.screenX;
    const dy = e.screenY - press.screenY;
    if (!press.dragging) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      press.dragging = true;
      window.api.startWindowDrag();
    }
    // One move per frame: the pointer reports faster than a window can repaint.
    pending = { dx, dy };
    if (!frame) frame = requestAnimationFrame(flush);
  };

  const onUp = (e: PointerEvent): void => {
    if (press && e.pointerId === press.id) finish();
  };

  // Capture, so the list's own click listener never hears a click that ended a drag.
  const onClick = (e: MouseEvent): void => {
    if (!swallowClick) return;
    swallowClick = false;
    e.stopPropagation();
  };

  space.addEventListener('pointerdown', onDown);
  space.addEventListener('pointermove', onMove);
  space.addEventListener('pointerup', onUp);
  space.addEventListener('pointercancel', finish);
  space.addEventListener('lostpointercapture', finish);
  space.addEventListener('click', onClick, true);
  return () => {
    finish();
    space.removeEventListener('pointerdown', onDown);
    space.removeEventListener('pointermove', onMove);
    space.removeEventListener('pointerup', onUp);
    space.removeEventListener('pointercancel', finish);
    space.removeEventListener('lostpointercapture', finish);
    space.removeEventListener('click', onClick, true);
  };
}
