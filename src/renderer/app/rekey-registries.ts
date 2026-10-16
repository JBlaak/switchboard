/**
 * Following a re-key outside the store.
 *
 * The store moves every slice keyed by session id in one reducer pass (see
 * `rekeyState` in `state/root`). What it cannot hold — the open terminals, the
 * shared rows, the held-back terminal output, the persisted session on screen
 * — moves here, all of it, in an order that matters:
 *
 * 1. The collections (`openSessions`, `sessionMap`, `pendingSessions`, and the
 *    row's own id). Everything after this looks a session up in them.
 * 2. The terminal's write buffer, whose re-armed flush finds the terminal in
 *    `openSessions` under the new id.
 * 3. The session on screen as persisted for a reload, read from the state the
 *    reducer already moved.
 *
 * Its own module, free of the DOM, so it can be tested in node; the IPC
 * follow-up calls it before it does anything else.
 */
import { rekeySessions } from '../state/session-store';
import { STORAGE_KEYS, writeStored } from '../state/storage';
import { rekeyWriteBuffer } from '../features/terminal/write-buffer';
import type { RendererState } from '../state/root';

/** `state` is the store's state after the re-key. */
export function rekeyRegistries(oldId: string, newId: string, state: RendererState): void {
  if (oldId === newId) return;
  rekeySessions(oldId, newId);
  rekeyWriteBuffer(oldId, newId);
  if (state.view.activeSessionId === newId) {
    writeStored('sessionStorage', STORAGE_KEYS.activeSessionId, newId);
  }
}
