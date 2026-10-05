/**
 * Whether the app follows the OS colour scheme or is pinned to light or dark.
 *
 * One value drives everything: the main process hands it to Electron as
 * `nativeTheme.themeSource`, which is what flips `prefers-color-scheme` in the
 * renderer — so the stylesheet, the window chrome and the terminal all follow
 * the same switch rather than each keeping a copy of the choice.
 */

export type Appearance = 'system' | 'light' | 'dark';

/** The order the toolbar button cycles through. */
export const APPEARANCES: readonly Appearance[] = ['system', 'light', 'dark'];

/** Following the OS is the default: it is what the app did before the toggle existed. */
export const DEFAULT_APPEARANCE: Appearance = 'system';

/** How each mode is named in the UI. */
export const APPEARANCE_LABELS: Record<Appearance, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

export function isAppearance(value: unknown): value is Appearance {
  return typeof value === 'string' && (APPEARANCES as readonly string[]).includes(value);
}

/**
 * A stored or received value, made safe to hand to Electron.
 *
 * The settings blob is untyped JSON and the IPC argument comes from the
 * renderer; anything that is not a known mode falls back to the default rather
 * than reaching `themeSource`, which throws on an unknown string.
 */
export function normaliseAppearance(value: unknown): Appearance {
  return isAppearance(value) ? value : DEFAULT_APPEARANCE;
}

/** The mode one click on the toggle moves to: system → light → dark → system. */
export function nextAppearance(mode: Appearance): Appearance {
  const index = APPEARANCES.indexOf(mode);
  return APPEARANCES[(index + 1) % APPEARANCES.length];
}
