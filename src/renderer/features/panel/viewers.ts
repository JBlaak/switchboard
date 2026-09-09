/**
 * Which of the main area's panels is showing.
 *
 * Six panels share one space — terminals, plans, agent files, statistics,
 * settings, the message-history viewer and the code area — and only one may be
 * visible. Doing that by hiding all of them and then showing one is what stops a
 * leftover panel appearing behind another.
 *
 * This is the only owner of that visibility. Anything that hides the panels by
 * hand goes stale the moment a panel is added — which is exactly what happened
 * to the stats tab, whose hand-rolled version never learned about the
 * message-history viewer.
 */
import {
  codeArea, jsonlViewer, memoryViewer, placeholder, planViewer, settingsViewer, statsViewer,
  terminalArea,
} from '../../lib/dom';

/** Every panel that can occupy the main area, and how it is displayed. */
const PANELS = [
  { element: () => planViewer, display: 'flex' },
  { element: () => memoryViewer, display: 'flex' },
  { element: () => statsViewer, display: 'flex' },
  { element: () => settingsViewer, display: 'flex' },
  { element: () => jsonlViewer, display: 'flex' },
  { element: () => codeArea, display: 'flex' },
] as const;

export type PanelName = 'plan' | 'memory' | 'stats' | 'settings' | 'jsonl' | 'code';

const BY_NAME: Record<PanelName, () => HTMLElement> = {
  plan: () => planViewer,
  memory: () => memoryViewer,
  stats: () => statsViewer,
  settings: () => settingsViewer,
  jsonl: () => jsonlViewer,
  code: () => codeArea,
};

/**
 * Hide every panel, and leave the terminal alone.
 *
 * For the one caller that needs the terminal to stay up while the panels go
 * down: the grid replaces what is *inside* `#terminal-area`, so it cannot go
 * through `showViewer`, but it still has to clear whatever panel was showing.
 * It used to name the panels itself, which is the same staleness this module
 * exists to prevent — a panel added later was hidden everywhere except there.
 */
export function hideViewerPanels(): void {
  for (const panel of PANELS) panel.element().style.display = 'none';
}

/** Show one panel in place of the terminal. */
export function showViewer(name: PanelName): void {
  placeholder.style.display = 'none';
  terminalArea.style.display = 'none';
  hideViewerPanels();
  BY_NAME[name]().style.display = 'flex';
}

/** Put the terminal back. */
export function hideAllViewers(): void {
  hideViewerPanels();
  terminalArea.style.display = '';
}
