/**
 * Moving the window by hand, for the one place a CSS drag region won't do.
 *
 * A `-webkit-app-region: drag` area is title bar to macOS: a press there moves
 * the window and never reaches the page as a click. The sidebar's blank space
 * has to be both — a click puts the session away, a drag moves the window — so
 * the renderer says when a press turns into a drag and how far the pointer has
 * come since, and the window follows from here.
 *
 * The offsets are the pointer's `screenX`/`screenY` deltas: screen points, the
 * same unit `setPosition` takes whatever the display's scale, and measured
 * from where the drag started so a dropped or late message cannot add up drift.
 */
import type { BrowserWindow } from 'electron';

interface Grip {
  x: number;
  y: number;
}

export class ElectronWindowDrag {
  /** Where the window was when the drag started; null when no drag is on. */
  private grip: Grip | null = null;

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  /** Take hold of the window where it is now. A full-screen window stays put. */
  start(): void {
    const window = this.getWindow();
    if (!window || window.isFullScreen()) return;
    const [x = 0, y = 0] = window.getPosition();
    this.grip = { x, y };
  }

  move(dx: number, dy: number): void {
    const window = this.getWindow();
    if (!window || !this.grip || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    window.setPosition(Math.round(this.grip.x + dx), Math.round(this.grip.y + dy));
  }

  end(): void {
    this.grip = null;
  }
}
