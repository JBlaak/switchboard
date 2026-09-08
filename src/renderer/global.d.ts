/**
 * Ambient declarations for the renderer.
 *
 * `window.api` is the only global the renderer still relies on, and it is typed
 * off the preload's own contract — so renaming an IPC method there breaks
 * compilation here instead of failing at runtime.
 */
import type { SwitchboardApi } from '../preload/index.js';

declare global {
  interface Window {
    api: SwitchboardApi;
  }
}

export {};
