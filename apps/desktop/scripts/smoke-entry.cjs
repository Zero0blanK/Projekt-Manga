// Smoke-only entry: isolate every Electron store before loading the real main process.
const path = require('node:path');
const { app } = require('electron');

const userData = process.env.PROJEKT_MANGA_SMOKE_USER_DATA;
if (!userData || !path.isAbsolute(userData)) {
  throw new Error('Smoke test requires an absolute temporary userData path');
}
app.setPath('userData', userData);
app.setPath('sessionData', userData);

// Keep smoke windows out of the way: shown (so Chromium keeps painting) but off-screen,
// without taking focus or a taskbar button. Playwright drives them over CDP, which needs
// neither.
app.on('browser-window-created', (_event, win) => {
  const hide = () => {
    if (win.isDestroyed()) return;
    win.setSkipTaskbar(true);
    win.setPosition(-32000, -32000);
  };
  hide();
  win.show = () => {
    hide();
    win.showInactive();
  };
  win.focus = () => {};
  win.on('show', hide);
});

require('../dist/main/index.js');
