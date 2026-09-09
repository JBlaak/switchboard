/**
 * Ambient declarations for the renderer.
 *
 * `window.api` is the only global the renderer relies on, and it is typed off
 * the shared IPC contract — so renaming a channel breaks compilation on both
 * sides instead of failing at runtime on one.
 */
import type { SwitchboardApi } from '../ipc/api';

declare global {
  interface Window {
    api: SwitchboardApi;
  }
}

export {};
