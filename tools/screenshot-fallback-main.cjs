// Simulate Windows owning only the shortcuts named by the test, even on a busy desktop.
const { app, globalShortcut } = require('electron');
app.whenReady().then(() => {
  const busy = new Set((process.env.SNOWBALL_TEST_BUSY_KEYS || '').split(',').filter(Boolean));
  const registered = new Set();
  globalShortcut.register = key => {
    if (busy.has(key) || registered.has(key)) return false;
    registered.add(key);
    return true;
  };
  globalShortcut.unregister = key => registered.delete(key);
  globalShortcut.unregisterAll = () => registered.clear();
  globalShortcut.isRegistered = key => registered.has(key);
  require('../main');
});
