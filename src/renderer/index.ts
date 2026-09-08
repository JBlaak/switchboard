/**
 * Renderer entry point.
 *
 * index.html used to load fifteen <script> tags into one shared global scope;
 * this is the single bundle that replaced them. The imports below are ordered
 * the way those tags were, because several of these modules do real work when
 * they evaluate — wiring listeners, reading the DOM — and that order was load
 * order before it was import order.
 *
 * Vendor CSS is pulled in here too, so esbuild emits it alongside the bundle
 * rather than index.html reaching into node_modules.
 */
import '@xterm/xterm/css/xterm.css';

import './icons.js';
import './viewer-toolbar.js';
import './viewer-panel.js';
import './file-panel.js';
import './settings-panel.js';
import './utils.js';
import './terminal-themes.js';
import './terminal-manager.js';
import './grid-view.js';
import './stats-view.js';
import './jsonl-viewer.js';
import './dialogs.js';
import './sidebar.js';
import './plans-memory-view.js';
import './app.js';
