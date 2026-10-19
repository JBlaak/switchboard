// Throwaway spike for #144 (Quick Ask). Not app code.
//
//   npx electron spike/quick-ask/main.js <mode>
//
// Modes
//   focus        panel over another app, then close it; logs the frontmost app before/during/after
//                env SHOW=show|showInactive (default show), HIDE=1 calls app.hide() on close,
//                FS=1 puts TextEdit into full screen first, SHOT=<png> screenshots while shown
//   glass        a still 680 x 460 transparent panel over a busy backdrop
//                env GLASS=css|native|native-slab|vibrancy, SHOT=<png>
//
// Every result line starts with "SPIKE" so the runner can grep it.
const { app, BrowserWindow, screen, ipcMain } = require('electron');
const { execFileSync } = require('child_process');
const path = require('path');

const mode = process.argv[2] || 'focus';
const env = process.env;
const t0 = Date.now();
const log = (...a) => console.log('SPIKE', `+${Date.now() - t0}ms`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const osa = (script) => {
  try { return execFileSync('osascript', ['-e', script], { encoding: 'utf8' }).trim(); }
  catch (e) { return `ERR ${String(e.stderr || e.message).trim()}`; }
};
const frontmost = () => osa('tell application "System Events" to get name of first application process whose frontmost is true');
const shot = (file) => {
  try { execFileSync('screencapture', ['-x', file], { stdio: 'pipe' }); log('screenshot', file); }
  catch (e) { log('screencapture FAILED:', String(e.stderr || e.message).trim()); }
};

function createPanel({ width = 680, height = 460, page = 'panel.html', query = {}, extra = {} } = {}) {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width: dw, height: dh } = display.workArea;
  const win = new BrowserWindow({
    type: 'panel',
    width, height,
    x: Math.round(x + (dw - width) / 2),
    y: Math.round(y + dh / 4 - 30),
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
    ...extra,
  });
  win.setAlwaysOnTop(true, 'pop-up-menu');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, page), { query });
  return win;
}

async function focusMode() {
  // A stand-in for Switchboard's main window, so we can see whether it gets raised.
  const main = new BrowserWindow({ width: 900, height: 600, title: 'Spike main window' });
  main.loadURL('data:text/html,<body style="background:%23c33;color:white;font:40px system-ui">SPIKE MAIN WINDOW</body>');
  const panel = createPanel({ page: 'panel.html', query: { glass: 'css', state: 'edit' } });
  await new Promise((r) => panel.webContents.once('did-finish-load', r));
  await sleep(800);

  let other;
  if (env.FS === '1') {
    // A second Electron process stands in for a full-screen app (AXFullScreen needs Accessibility).
    other = require('child_process').spawn(process.execPath, [path.join(__dirname, 'fullscreen-app.js')], { stdio: ['ignore', 'inherit', 'ignore'] });
    await sleep(4000);
    log('other app pid', other.pid);
  } else {
    osa('tell application "TextEdit" to activate');
    osa('tell application "TextEdit" to make new document with properties {text:""}');
    await sleep(1200);
  }
  const frontPid = () => osa('tell application "System Events" to get unix id of first application process whose frontmost is true');
  const windows = (label) => {
    if (!env.WINDOWS_TOOL) return;
    const out = execFileSync(env.WINDOWS_TOOL, ['Electron'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    log(`${label} on-screen Electron windows (front to back):`);
    out.forEach((line) => log(`  ${label}  ${line}`));
  };
  log('spike pid', process.pid, 'panel=680x460, main=900x600');
  log('BEFORE frontmost=', frontmost(), 'pid', frontPid(), 'app.isHidden=', app.isHidden?.(), 'main.isFocused=', main.isFocused());
  windows('BEFORE');

  const tShow = Date.now();
  if (env.SHOW === 'showInactive') { panel.showInactive(); } else { panel.show(); panel.focus(); }
  panel.webContents.focus();
  await sleep(700);
  windows('DURING');
  log('DURING frontmost=', frontmost(), 'pid', frontPid(), 'panel.isVisible=', panel.isVisible(), 'panel.isFocused=', panel.isFocused(),
    'main.isFocused=', main.isFocused(), 'BrowserWindow.getFocusedWindow=', BrowserWindow.getFocusedWindow()?.getTitle() ?? null,
    `(${Date.now() - tShow}ms after show)`);
  if (env.SHOT) shot(env.SHOT);
  log('keystroke into panel:', osa('tell application "System Events" to keystroke "typed-in-panel"') || 'ok');
  await sleep(400);
  log('DURING panel input value=', JSON.stringify(await panel.webContents.executeJavaScript('document.querySelector("#qa-input").value')));
  log('DURING frontmost after typing=', frontmost());

  panel.hide();
  if (env.HIDE === '1') app.hide();
  await sleep(700);
  log('AFTER frontmost=', frontmost(), 'pid', frontPid(), 'app.isHidden=', app.isHidden?.(), 'main.isVisible=', main.isVisible());
  windows('AFTER');
  await sleep(2000);
  log('AFTER+2s frontmost=', frontmost(), 'app.isHidden=', app.isHidden?.());
  windows('AFTER+2s');
  if (other) { other.kill(); await sleep(1500); app.quit(); return; }
  log('keystroke after close:', osa('tell application "System Events" to keystroke "zz"') || 'ok');
  await sleep(400);
  log('AFTER TextEdit doc text=', JSON.stringify(osa('tell application "TextEdit" to get text of front document')));
  osa('tell application "TextEdit" to close every document saving no');
  app.quit();
}

async function glassMode() {
  const kind = env.GLASS || 'css';
  const backdrop = new BrowserWindow({ width: 1300, height: 760, title: 'Busy backdrop', show: false });
  backdrop.loadFile(path.join(__dirname, 'backdrop.html'));
  backdrop.once('ready-to-show', () => { backdrop.center(); backdrop.show(); });
  ipcMain.on('backdrop-click', (_e, where) => log('BACKDROP received click at', where));
  ipcMain.on('panel-event', (_e, what) => log('PANEL received', what));
  await sleep(1200);

  let panel;
  if (kind === 'native-slab') {
    // The hybrid's "still" state if the window had to be the slab: native glass needs the whole window.
    panel = createPanel({ width: 640, height: 60, query: { glass: 'native', state: 'edit', fill: '1' } });
  } else if (kind === 'vibrancy') {
    panel = createPanel({ query: { glass: 'native', state: 'choose' }, extra: { vibrancy: 'hud', visualEffectState: 'active' } });
  } else {
    panel = createPanel({ query: { glass: kind, state: 'choose' } });
  }
  await new Promise((r) => panel.webContents.once('did-finish-load', r));

  if (kind === 'native' || kind === 'native-slab') {
    const glassPath = env.LIQUID_GLASS_PATH; // installed with npm i --no-save outside the repo
    try {
      const liquidGlass = require(glassPath);
      const lg = liquidGlass.default || liquidGlass;
      log('electron-liquid-glass loaded; isGlassSupported=', lg.isGlassSupported());
      const id = lg.addView(panel.getNativeWindowHandle(), { cornerRadius: 30 });
      log('addView id=', id);
    } catch (e) {
      log('electron-liquid-glass FAILED to load', e.message);
    }
  }
  panel.setIgnoreMouseEvents(true, { forward: true });
  ipcMain.on('slab-hover', (_e, inside) => {
    panel.setIgnoreMouseEvents(!inside, { forward: true });
    log('slab hover ->', inside ? 'capture mouse' : 'pass through');
  });
  panel.showInactive();
  await sleep(1200);
  log('panel bounds', JSON.stringify(panel.getBounds()));
  // What the page hands the window server: sample alpha inside and outside the slab.
  // If the slab is translucent here, whatever is behind the window shows through unblurred,
  // because backdrop-filter can only sample the page's own pixels, not other windows.
  {
    const img = await panel.webContents.capturePage();
    const { width, height } = img.getSize();
    const bmp = img.toBitmap(); // BGRA
    const sx = width / 680, sy = height / 460;
    const px = (x, y) => { const i = (Math.round(y * sy) * width + Math.round(x * sx)) * 4; return { b: bmp[i], g: bmp[i + 1], r: bmp[i + 2], a: bmp[i + 3] }; };
    log('capturePage size', width + 'x' + height,
      'pixel in slab (300,45)=', JSON.stringify(px(300, 45)),
      'pixel in list (300,170)=', JSON.stringify(px(300, 170)),
      'pixel outside slab (40,430)=', JSON.stringify(px(40, 430)));
    if (env.PAGE_SHOT) require('fs').writeFileSync(env.PAGE_SHOT, img.toPNG());
  }
  if (env.SHOT) {
    shot(env.SHOT);
    // Fallback: desktopCapturer (also needs Screen Recording; logs what it gets).
    try {
      const { desktopCapturer } = require('electron');
      const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1800, height: 1169 } });
      const img = srcs[0]?.thumbnail;
      const bmp = img?.toBitmap();
      const nonBlack = bmp ? bmp.some((v, i) => i % 4 !== 3 && v > 8) : false;
      log('desktopCapturer sources=', srcs.length, 'size=', JSON.stringify(img?.getSize()), 'hasContent=', nonBlack);
      if (img && nonBlack) require('fs').writeFileSync(env.SHOT.replace(/\.png$/, '-dc.png'), img.toPNG());
    } catch (e) { log('desktopCapturer FAILED', e.message); }
  }

  // Pass-through check: click inside the transparent part of the panel, below the slab.
  const b = panel.getBounds();
  const clicker = env.CLICK_TOOL;
  if (clicker) {
    const outside = [b.x + 40, b.y + b.height - 30];
    const inside = [b.x + b.width / 2, b.y + 30];
    execFileSync(clicker, [String(outside[0]), String(outside[1])]);
    await sleep(300);
    log('cursor after synthetic move =', JSON.stringify(screen.getCursorScreenPoint()), 'target', outside.join(','));
    execFileSync(clicker, [String(outside[0]), String(outside[1]), 'click']);
    await sleep(500);
    log('clicked outside slab at', outside.join(','));
    execFileSync(clicker, [String(inside[0]), String(inside[1])]);
    await sleep(300);
    execFileSync(clicker, [String(inside[0]), String(inside[1]), 'click']);
    await sleep(500);
    log('clicked inside slab at', inside.join(','));
  }
  await sleep(500);
  app.quit();
}

// screencapture and desktopCapturer both need Screen Recording permission, which this session lacks.
// This renders the CSS glass over the busy backdrop inside one page and saves it with capturePage(),
// which Chromium composites exactly as the panel would draw it (backdrop-filter included).
async function compositeMode() {
  const { nativeTheme } = require('electron');
  const fs = require('fs');
  const out = env.OUT || path.join(__dirname, 'shots');
  app.on('window-all-closed', () => {});
  for (const theme of ['light', 'dark']) {
    nativeTheme.themeSource = theme;
    for (const state of ['edit', 'choose']) {
      const w = new BrowserWindow({ width: 1000, height: 560, show: false, webPreferences: { offscreen: false } });
      await w.loadFile(path.join(__dirname, 'backdrop.html'));
      const panelHtml = fs.readFileSync(path.join(__dirname, 'panel.html'), 'utf8');
      await w.webContents.executeJavaScript(`(() => {
        const doc = new DOMParser().parseFromString(${JSON.stringify(panelHtml)}, 'text/html');
        const style = doc.querySelector('style'); style.textContent = style.textContent.replace(/html, body \\{[^}]*\\}/, '');
        document.head.appendChild(style);
        const host = document.createElement('div');
        host.style.cssText = 'position:fixed;left:160px;top:60px;width:680px;height:460px;outline:1px dashed rgba(0,0,0,.35)';
        host.appendChild(doc.querySelector('#slab'));
        document.body.appendChild(host);
        if (${JSON.stringify(state)} === 'choose') {
          host.querySelector('#qa-input').value = 'fix the flaky upload test in the iOS app';
          host.querySelector('#extra').innerHTML = '<div class="foot">Patch isn\\'t sure which project you mean</div><ul class="choices"><li class="on"><span>cityrow-ios</span><span>~/Development/MoveLab/cityrow-ios</span></li><li><span>waterrower-connect-ios</span><span>~/Development/MoveLab/waterrower-connect-ios</span></li><li><span>KMM-SessionManager</span><span>~/Development/MoveLab/KMM-SessionManager</span></li></ul>';
        }
        document.getElementById('log').textContent = 'CSS glass (prototype) · ${theme} · dashed = 680x460 still window';
      })()`);
      await sleep(400);
      const img = await w.webContents.capturePage();
      const file = path.join(out, `css-glass-${theme}-${state}.png`);
      fs.writeFileSync(file, img.toPNG());
      log('saved', file, JSON.stringify(img.getSize()));
      w.destroy();
    }
  }
  app.quit();
}

app.whenReady().then(() => (mode === 'glass' ? glassMode() : mode === 'composite' ? compositeMode() : focusMode()));
