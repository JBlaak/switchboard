/**
 * Which of the main area's panels is showing.
 *
 * Two panels share one space — terminals and settings — and only one may be
 * visible. Doing that by hiding all of them and then showing one is what stops
 * a leftover panel appearing behind another.
 */
import {
  placeholder, settingsViewer, terminalArea,
} from '../../lib/dom';

/** Every panel that can occupy the main area, and how it is displayed. */
const PANELS = [
  { element: () => settingsViewer, display: 'flex' },
] as const;

export type PanelName = 'settings';

const BY_NAME: Record<PanelName, () => HTMLElement> = {
  settings: () => settingsViewer,
};

/** Show one panel in place of the terminal. */
export function showViewer(name: PanelName): void {
  placeholder.style.display = 'none';
  terminalArea.style.display = 'none';
  for (const panel of PANELS) panel.element().style.display = 'none';
  BY_NAME[name]().style.display = 'flex';
}

/** Put the terminal back. */
export function hideAllViewers(): void {
  for (const panel of PANELS) panel.element().style.display = 'none';
  terminalArea.style.display = '';
}
