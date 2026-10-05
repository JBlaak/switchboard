/**
 * The sidebar toolbar's system / light / dark button.
 *
 * The renderer does not apply the scheme itself: it asks main, which sets
 * `nativeTheme.themeSource`, and `prefers-color-scheme` follows. So this module
 * only has to show the stored mode and cycle it — the stylesheet, the window
 * chrome and the terminal all react to the media query on their own.
 */
import {
  APPEARANCE_LABELS, nextAppearance, normaliseAppearance,
} from '../../../domain/settings/appearance';
import { ICONS } from '../../lib/icons';
import type { Appearance } from '../../../domain/settings/appearance';
import type { GlobalSettings } from '../../../domain/settings/settings';

const ICON_FOR: Record<Appearance, string> = {
  system: ICONS.monitor(18),
  light: ICONS.sun(18),
  dark: ICONS.moon(18),
};

function render(button: HTMLElement, mode: Appearance): void {
  button.innerHTML = ICON_FOR[mode];
  const next = APPEARANCE_LABELS[nextAppearance(mode)];
  button.title = `Appearance: ${APPEARANCE_LABELS[mode]} (click for ${next})`;
}

export function installAppearanceToggle(): void {
  const button = document.getElementById('appearance-toggle-btn');
  if (!button) return;

  // Rendered as the default straight away so the toolbar never shows an empty
  // button while the stored setting is read.
  let mode: Appearance = normaliseAppearance(undefined);
  render(button, mode);

  void window.api.getSetting<GlobalSettings>('global').then((global) => {
    mode = normaliseAppearance(global?.appearance);
    render(button, mode);
  });

  button.addEventListener('click', () => {
    // Shown immediately; main applying the scheme is what actually repaints,
    // and it does not need the button to wait for it.
    mode = nextAppearance(mode);
    render(button, mode);
    void window.api.setAppearance(mode);
  });
}
