/**
 * `window.quickAsk`, set by the Quick Ask pop-up's own preload. Only the
 * pop-up's bundle reads it; the main window has `window.api` instead.
 */
import type { QuickAskApi } from '../../ipc/quick-ask-api';

declare global {
  interface Window {
    quickAsk: QuickAskApi;
  }
}

export {};
