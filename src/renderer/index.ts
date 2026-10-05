/**
 * Renderer entry point.
 *
 * Vendor CSS is pulled in here so esbuild emits it alongside the bundle rather
 * than index.html reaching into node_modules. Everything else is one call:
 * modules no longer do work when they evaluate, so there is no load order to
 * preserve — `bootstrap` decides what happens and when.
 */
import '@xterm/xterm/css/xterm.css';
// The Soft MoveLab type, bundled (as data URLs) so it renders offline.
import '@fontsource-variable/mulish';
import '@fontsource-variable/nunito-sans';

import { bootstrap } from './app/bootstrap';

bootstrap();
