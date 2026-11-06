/**
 * The 1Password heads-up pop-up's entry point: a bundle of its own, loaded
 * into the pop-up's window at the first heads-up and kept there, hidden,
 * between them.
 */
import '@fontsource-variable/mulish';
import '@fontsource-variable/nunito-sans';

import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {HeadsUp} from './HeadsUp';

createRoot(document.getElementById('heads-up')!).render(
    <StrictMode>
        <HeadsUp />
    </StrictMode>,
);
window.headsUp.ready();
