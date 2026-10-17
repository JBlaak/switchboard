/**
 * The renderer's Web Storage, behind two calls that cannot throw.
 *
 * A leaf of its own so the store can read the persisted session on screen at
 * creation without importing the session store that adapts it.
 */

/**
 * The keys view state is persisted under.
 *
 * Named here because both the read and the write have to agree: they used to be
 * spelled differently at the two ends ('activeSessionId' read, but
 * 'state.activeSessionId' written), which silently stopped the open session
 * being restored after a reload.
 */
export const STORAGE_KEYS = {
  activeSessionId: 'activeSessionId',
  expandedSlugs: 'expandedSlugs',
  /** The image compare mode a new card opens in (localStorage, so it outlives a restart). */
  imageCompareMode: 'imageCompareMode',
  /** What sits behind an image card's images (localStorage). */
  imageCompareBackground: 'imageCompareBackground',
  /** `owner/repo#n` → the plan's level last seen, as JSON (localStorage), so a level-up outlives a restart (A4). */
  planLevelsSeen: 'planLevelsSeen',
} as const;

/**
 * Web Storage, when there is any.
 *
 * The unit tests import this module in Node, where neither store exists — and a
 * browser with site data blocked throws on the property access itself, not just
 * on the call. Both are handled here so no caller has to.
 */
export function readStored(store: 'sessionStorage' | 'localStorage', key: string): string | null {
  try {
    return globalThis[store]?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Write, or forget, a persisted value. Silent when there is no storage. */
export function writeStored(
  store: 'sessionStorage' | 'localStorage',
  key: string,
  value: string | null,
): void {
  try {
    if (value === null) globalThis[store]?.removeItem(key);
    else globalThis[store]?.setItem(key, value);
  } catch {
    // Site data blocked; the preference simply does not persist.
  }
}
