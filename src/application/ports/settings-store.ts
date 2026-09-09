/**
 * Key/value settings storage.
 *
 * Values are whatever the caller put in — the settings panel writes arbitrary
 * per-feature keys — so the port is generic rather than typed per key. The
 * layering rules that turn a global blob and a project blob into one resolved
 * value live in SettingsService, not here.
 */

export interface SettingsStore {
  get<T = unknown>(key: string): T | null;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}
