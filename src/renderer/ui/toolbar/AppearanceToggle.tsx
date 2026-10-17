/**
 * The system / light / dark button.
 *
 * It only shows the stored mode and cycles it: main sets
 * `nativeTheme.themeSource`, and the stylesheet, the window chrome and the
 * terminal all follow `prefers-color-scheme` on their own.
 */
import { appearanceTitle } from '../../../domain/settings/appearance';
import { ICONS } from '../../lib/icons';
import { useStore } from '../use-store';
import { cycleAppearance } from './actions';
import type { Appearance } from '../../../domain/settings/appearance';
import type { JSX } from 'react';

const ICON_FOR: Record<Appearance, string> = {
  system: ICONS.monitor(18),
  light: ICONS.sun(18),
  dark: ICONS.moon(18),
};

export function AppearanceToggle(): JSX.Element {
  const mode = useStore(s => s.toolbar.appearance);
  return (
    <button
      id="appearance-toggle-btn"
      title={appearanceTitle(mode)}
      dangerouslySetInnerHTML={{ __html: ICON_FOR[mode] }}
      onClick={cycleAppearance}
    />
  );
}
