/*
 * The phone's view of a session's terminal: xterm.js at the size it fits the WebView to, fed by the app.
 *
 * The app writes with sb.write(base64 of UTF-8 bytes) and clears with sb.reset(); this page tells the app
 * "ready <cols> <rows>" once it has a size and "size <cols> <rows>" whenever the fit changes, through the
 * `switchboard` object the app injects. Typing never goes into xterm: the app's prompt box and key bar are
 * the input, so stdin is off and the hidden textarea can't take focus or raise the keyboard.
 */
(function () {
  'use strict';

  var THEME = {
    background: '#141517', foreground: '#d9d7d2', cursor: '#8fd8bf', selectionBackground: '#2a4a40',
    black: '#1c1d20', red: '#ee8b8b', green: '#6cc4a1', yellow: '#f0cf7e', blue: '#9cc5e8', magenta: '#c8b8e8',
    cyan: '#8fd8bf', white: '#cfcdc8',
    brightBlack: '#6e6d69', brightRed: '#f4a8a8', brightGreen: '#8fd8bf', brightYellow: '#f5dc9c',
    brightBlue: '#b9d7f0', brightMagenta: '#dccff2', brightCyan: '#b0e6d3', brightWhite: '#ecebe8'
  };

  var element = document.getElementById('terminal');
  var term = null;
  var fit = null;
  var reported = { cols: 0, rows: 0 };
  var refitTimer = null;

  function post(text) {
    if (window.switchboard) window.switchboard.postMessage(text);
  }

  function bytesOf(base64) {
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function report(kind) {
    if (term.cols === reported.cols && term.rows === reported.rows && kind === 'size') return;
    reported = { cols: term.cols, rows: term.rows };
    post(kind + ' ' + term.cols + ' ' + term.rows);
  }

  function refit() {
    var proposed = fit.proposeDimensions();
    if (!proposed || !isFinite(proposed.cols) || !isFinite(proposed.rows)) return;
    fit.fit();
    report('size');
  }

  /* The keyboard sliding in resizes the page every frame; the PTY gets the size it settles on. */
  function refitSoon() {
    clearTimeout(refitTimer);
    refitTimer = setTimeout(refit, 150);
  }

  function lockInput(textarea) {
    if (!textarea) return;
    textarea.readOnly = true;
    textarea.tabIndex = -1;
    textarea.setAttribute('inputmode', 'none');
    textarea.addEventListener('focus', function () { textarea.blur(); });
  }

  /* One finger scrolls the scrollback a line per cell height dragged. */
  function scrollByTouch() {
    var lastY = null;
    var carried = 0;
    element.addEventListener('touchstart', function (event) {
      if (event.touches.length !== 1) return;
      lastY = event.touches[0].clientY;
      carried = 0;
    }, { capture: true, passive: true });
    element.addEventListener('touchmove', function (event) {
      if (lastY === null || event.touches.length !== 1) return;
      var y = event.touches[0].clientY;
      carried += lastY - y;
      lastY = y;
      var cellHeight = element.clientHeight / term.rows;
      var lines = carried > 0 ? Math.floor(carried / cellHeight) : Math.ceil(carried / cellHeight);
      if (lines !== 0) {
        term.scrollLines(lines);
        carried -= lines * cellHeight;
      }
      event.preventDefault();
      event.stopPropagation();
    }, { capture: true, passive: false });
    element.addEventListener('touchend', function () { lastY = null; }, { capture: true, passive: true });
  }

  function start() {
    term = new Terminal({
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 11,
      lineHeight: 1.2,
      theme: THEME,
      scrollback: 10000,
      convertEol: true,
      cursorBlink: false,
      disableStdin: true
    });
    fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(element);
    lockInput(term.textarea);
    scrollByTouch();
    fit.fit();
    window.sb = {
      write: function (base64) { term.write(bytesOf(base64)); },
      reset: function () { term.reset(); }
    };
    report('ready');
    new ResizeObserver(refitSoon).observe(element);
  }

  document.fonts.load('11px "JetBrains Mono"').then(start, start);
})();
