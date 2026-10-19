// A separate "other app" that goes native full screen (own Space), so the panel can be shown over it
// without Accessibility permission. Run as its own Electron process. Quits after 25 s.
const { app, BrowserWindow } = require('electron');
app.setName('FullscreenOther');
app.whenReady().then(() => {
  const w = new BrowserWindow({ width: 800, height: 600, title: 'Full-screen other app' });
  w.loadURL('data:text/html,<body style="background:%23135;color:white;font:48px system-ui">FULL-SCREEN OTHER APP</body>');
  w.once('ready-to-show', () => { w.show(); w.setFullScreen(true); });
  w.on('enter-full-screen', () => console.log('SPIKE other app entered full screen, pid', process.pid));
  setTimeout(() => app.quit(), 25000);
});
