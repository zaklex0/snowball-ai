// Reserve keys before loading the real app, to reproduce another program owning them.
const { app, globalShortcut } = require('electron');
app.whenReady().then(() => {
  for (const key of (process.env.SNOWBALL_TEST_BUSY_KEYS || '').split(',').filter(Boolean))
    globalShortcut.register(key, () => {});
  require('../main');
});
