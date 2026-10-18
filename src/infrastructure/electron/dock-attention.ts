/**
 * Bouncing the dock icon while a session needs input.
 *
 * The renderer owns what "needs input" means (an OSC 9 request, or questions
 * waiting), so it says how many sessions are in that block and the dock
 * follows from here. A critical bounce keeps going until the app is brought
 * forward; macOS ignores it while the app is already frontmost.
 *
 * It bounces again whenever the count rises, so a second session asking after
 * the user came and went still gets their attention, and it stops as soon as
 * nothing is waiting any more.
 */
import { app } from 'electron';

export class ElectronDockAttention {
  private count = 0;
  /** The running bounce, as `app.dock.bounce` answered it; null when none. */
  private bounceId: number | null = null;

  set(count: number): void {
    if (!Number.isFinite(count) || count < 0) return;
    const dock = app.dock;
    if (count > this.count && dock) {
      if (this.bounceId !== null) dock.cancelBounce(this.bounceId);
      this.bounceId = dock.bounce('critical');
    } else if (count === 0 && this.bounceId !== null) {
      dock?.cancelBounce(this.bounceId);
      this.bounceId = null;
    }
    this.count = count;
  }
}
