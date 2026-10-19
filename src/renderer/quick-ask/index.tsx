/**
 * The Quick Ask pop-up's entry point (#142): a bundle of its own, loaded into
 * the pop-up's window at startup and kept there, hidden, between uses.
 *
 * What main tells it, and the window losing focus, are wired here, once, so
 * they stay out of React's (StrictMode-doubled) effects.
 */
import '@fontsource-variable/mulish';
import '@fontsource-variable/nunito-sans';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QuickAsk } from './QuickAsk';
import { close, shown } from './actions';

window.quickAsk.onShown(shown);
// ⌥Space while showing (H1).
window.quickAsk.onCloseRequested(close);
// A click anywhere outside the slab lands in the window underneath, which
// takes the focus from the pop-up (B4).
window.addEventListener('blur', close);

createRoot(document.getElementById('quick-ask')!).render(
  <StrictMode><QuickAsk /></StrictMode>,
);
