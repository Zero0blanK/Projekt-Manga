// Smoke-only entry: isolate every Electron store before loading the real main process.
const path = require('node:path');
const { app } = require('electron');

const userData = process.env.PROJEKT_MANGA_SMOKE_USER_DATA;
if (!userData || !path.isAbsolute(userData)) {
  throw new Error('Smoke test requires an absolute temporary userData path');
}
app.setPath('userData', userData);
app.setPath('sessionData', userData);
require('../dist/main/index.js');
