import { openSessions } from '../../state/session-store';

// --- Terminal themes ---
export const TERMINAL_THEMES = {
  // The house theme. Background and foreground match --sb-bg-base and --sb-text so the
  // terminal reads as part of the app rather than a panel dropped into it, and the ANSI
  // ramp is built from the same brand palette (see :root in style.css).
  switchboard: {
    label: 'Switchboard',
    background: '#141517', foreground: '#d9d7d2', cursor: '#8fd8bf', selectionBackground: '#2a4a40',
    black: '#1c1d20', red: '#ee8b8b', green: '#6cc4a1', yellow: '#f0cf7e', blue: '#9cc5e8', magenta: '#c8b8e8', cyan: '#8fd8bf', white: '#cfcdc8',
    brightBlack: '#6e6d69', brightRed: '#f4a8a8', brightGreen: '#8fd8bf', brightYellow: '#f5dc9c', brightBlue: '#b9d7f0', brightMagenta: '#dccff2', brightCyan: '#b0e6d3', brightWhite: '#ecebe8',
  },
  ghostty: {
    label: 'Ghostty',
    background: '#292c33', foreground: '#ffffff', cursor: '#ffffff', cursorAccent: '#363a43', selectionBackground: '#ffffff', selectionForeground: '#292c33',
    black: '#1d1f21', red: '#bf6b69', green: '#b7bd73', yellow: '#e9c880', blue: '#88a1bb', magenta: '#ad95b8', cyan: '#95bdb7', white: '#c5c8c6',
    brightBlack: '#666666', brightRed: '#c55757', brightGreen: '#bcc95f', brightYellow: '#e1c65e', brightBlue: '#83a5d6', brightMagenta: '#bc99d4', brightCyan: '#83beb1', brightWhite: '#eaeaea',
  },
  tokyoNight: {
    label: 'Tokyo Night',
    background: '#1a1b26', foreground: '#c0caf5', cursor: '#c0caf5', selectionBackground: '#33467c',
    black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
    brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a', brightYellow: '#e0af68', brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#c0caf5',
  },
  catppuccinMocha: {
    label: 'Catppuccin Mocha',
    background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', selectionBackground: '#45475a',
    black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
    brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#94e2d5', brightWhite: '#a6adc8',
  },
  dracula: {
    label: 'Dracula',
    background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', selectionBackground: '#44475a',
    black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
    brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
  },
  nord: {
    label: 'Nord',
    background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', selectionBackground: '#434c5e',
    black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
    brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
  },
  solarizedDark: {
    label: 'Solarized Dark',
    background: '#002b36', foreground: '#839496', cursor: '#839496', selectionBackground: '#073642',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
  },
};

export type TerminalTheme = (typeof TERMINAL_THEMES)['switchboard'];

/**
 * Light versions of the themes that have one.
 *
 * Not entries in TERMINAL_THEMES, so not choices in the picker: they stand in
 * for their dark original while the app is in light mode. A theme without one
 * keeps its own palette in both modes.
 */
const LIGHT_VARIANTS: Record<string, TerminalTheme & { cursorAccent?: string; selectionForeground?: string }> = {
  // Picking "Switchboard" means "match the app", and in light mode the app is
  // white. The ANSI ramp keeps the dark theme's hues but darkens them until they
  // read on white — the dark theme's yellow and cyan are near-invisible there.
  switchboard: {
    label: 'Switchboard',
    background: '#fafbfd', foreground: '#262a31', cursor: '#1c6e56', selectionBackground: '#cdeee1',
    black: '#16181d', red: '#b83a3a', green: '#1c6e56', yellow: '#7a5a0c', blue: '#255f8c', magenta: '#553489', cyan: '#1a7a7a', white: '#aab2bd',
    brightBlack: '#7b8491', brightRed: '#9a3c22', brightGreen: '#2e8a68', brightYellow: '#946e10', brightBlue: '#2f74aa', brightMagenta: '#6a45a3', brightCyan: '#22908f', brightWhite: '#16181d',
  },
  // White for daylight, but charcoal text rather than black: about 10.5:1
  // against white instead of 21:1, keeping the softness of Ghostty's dark
  // theme. The muted hues are darkened only as far as 4.5:1 on white. Bright
  // white is the one inversion: programs use it for emphasis on a dark
  // background, so here it is the darkest ink rather than invisible white.
  ghostty: {
    label: 'Ghostty',
    background: '#ffffff', foreground: '#3b3f46', cursor: '#3b3f46', cursorAccent: '#ffffff', selectionBackground: '#3b3f46', selectionForeground: '#ffffff',
    black: '#3b3f46', red: '#a8504e', green: '#66702c', yellow: '#86661c', blue: '#4f6e8f', magenta: '#80628f', cyan: '#447a72', white: '#8a8d8b',
    brightBlack: '#74777c', brightRed: '#b04343', brightGreen: '#6f7a26', brightYellow: '#8f7016', brightBlue: '#4a70a8', brightMagenta: '#8a5fa6', brightCyan: '#3b7f72', brightWhite: '#2a2d33',
  },
};

/** The query the renderer's light palette hangs off; main drives it via `themeSource`. */
const LIGHT_SCHEME_QUERY = '(prefers-color-scheme: light)';

function prefersLight(): boolean {
  return typeof matchMedia === 'function' && matchMedia(LIGHT_SCHEME_QUERY).matches;
}

export let currentThemeName: string = 'switchboard';

/**
 * The theme to paint with, resolved against the current colour scheme.
 *
 * Only a theme with a light variant follows the scheme; every other theme is a
 * deliberate choice of its own palette and stays put.
 */
export function getTerminalTheme(): TerminalTheme {
  const name = currentThemeName in TERMINAL_THEMES ? currentThemeName : 'switchboard';
  const chosen = (TERMINAL_THEMES as Record<string, TerminalTheme>)[name];
  return (prefersLight() && LIGHT_VARIANTS[name]) || chosen;
}

export let TERMINAL_THEME: TerminalTheme = getTerminalTheme();

/**
 * Switch theme and repaint every open terminal.
 *
 * Lives here rather than in app.ts (where it hung off `window._applyTerminalTheme`)
 * because `currentThemeName` and `TERMINAL_THEME` are this module's own state —
 * an importer can read a live binding but cannot assign to one.
 */
export function applyTerminalTheme(themeName: string): void {
  currentThemeName = themeName;
  TERMINAL_THEME = getTerminalTheme();
  for (const [, entry] of openSessions) {
    entry.terminal.options.theme = TERMINAL_THEME;
    entry.element.style.backgroundColor = TERMINAL_THEME.background;
  }
}

/**
 * Repaint open terminals when the colour scheme flips.
 *
 * xterm takes its colours as values, not CSS variables, so the stylesheet
 * switching palettes does not reach it. Re-applying the current theme name
 * re-resolves it against the new scheme and updates `TERMINAL_THEME`, which is
 * what a terminal created afterwards reads.
 */
export function followColorSchemeInTerminals(): void {
  if (typeof matchMedia !== 'function') return;
  matchMedia(LIGHT_SCHEME_QUERY).addEventListener('change', () => {
    applyTerminalTheme(currentThemeName);
  });
}
