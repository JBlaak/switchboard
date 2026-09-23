/**
 * Which of the main area's panels is showing.
 *
 * Five panels share one space — terminals, plans, agent files, statistics,
 * settings and the message-history viewer — and only one may be visible. Doing
 * that by hiding all of them and then showing one is what stops a leftover
 * panel appearing behind another.
 */
import {
  jsonlViewer, memoryViewer, placeholder, planViewer, settingsViewer, statsViewer, terminalArea,
} from '../../lib/dom';

/** Every panel that can occupy the main area, and how it is displayed. */
const PANELS = [
  { element: () => planViewer, display: 'flex' },
  { element: () => memoryViewer, display: 'flex' },
  { element: () => statsViewer, display: 'flex' },
  { element: () => settingsViewer, display: 'flex' },
  { element: () => jsonlViewer, display: 'flex' },
] as const;

export type PanelName = 'plan' | 'memory' | 'stats' | 'settings' | 'jsonl';

const BY_NAME: Record<PanelName, () => HTMLElement> = {
  plan: () => planViewer,
  memory: () => memoryViewer,
  stats: () => statsViewer,
  settings: () => settingsViewer,
  jsonl: () => jsonlViewer,
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
