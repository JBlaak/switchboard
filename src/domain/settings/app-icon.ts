/**
 * Which icon the app shows in the Dock: the original Switchboard icon or Patch.
 *
 * The bundle's own icon (`build/icon.icns`) stays the Switchboard one, so the
 * Finder, Launchpad and the Dock while the app is closed always show it. The
 * choice is applied to the running app's Dock tile, which is where a user who
 * keeps Switchboard in the Dock alongside their other icons looks.
 */

export type AppIcon = 'switchboard' | 'patch';

/** The order the settings panel lists them in. */
export const APP_ICONS: readonly AppIcon[] = ['switchboard', 'patch'];

/** The original icon is the default: it is what the app showed before the setting existed. */
export const DEFAULT_APP_ICON: AppIcon = 'switchboard';

/** How each icon is named in the UI. */
export const APP_ICON_LABELS: Record<AppIcon, string> = {
  switchboard: 'Switchboard',
  patch: 'Patch',
};

export function isAppIcon(value: unknown): value is AppIcon {
  return typeof value === 'string' && (APP_ICONS as readonly string[]).includes(value);
}

/**
 * A stored or received value, made safe to pick a file with.
 *
 * The settings blob is untyped JSON; anything that is not a known icon falls
 * back to the default rather than naming a file that does not exist.
 */
export function normaliseAppIcon(value: unknown): AppIcon {
  return isAppIcon(value) ? value : DEFAULT_APP_ICON;
}
