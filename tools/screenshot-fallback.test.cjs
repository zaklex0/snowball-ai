'use strict';
const fs = require('fs'),
  path = require('path'),
  os = require('os'),
  assert = require('node:assert/strict'),
  { spawn } = require('child_process');
const { connect } = require('./guide-shots/cdp');
(async () => {
  for (const [busy, expected] of [
    ['Alt+Z', 'Alt+V'],
    ['Alt+Z,Alt+V', 'Alt+B'],
    ['Alt+Z,Alt+V,Alt+B', null],
  ]) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snowball-key-test-')),
      profile = path.join(tmp, 'profile');
    fs.mkdirSync(profile);
    fs.writeFileSync(
      path.join(profile, 'settings.json'),
      JSON.stringify({ dataDir: path.join(tmp, 'data'), captureShortcut: 'Alt+Z' }),
    );
    const child = spawn(
      require('electron'),
      [
        path.join(__dirname, 'screenshot-fallback-main.cjs'),
        '--inspect=9246',
        '--remote-debugging-port=9346',
        '--user-data-dir=' + profile,
      ],
      {
        env: { ...process.env, SNOWBALL_TEST_BUSY_KEYS: busy },
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    try {
      const main = await connect(9246, (t) => t.type === 'node');
      assert.equal(
        await main.ev("process.mainModule.require('electron').app.getPath('userData')"),
        profile,
      );
      const page = await connect(9346, (t) => /index\.html/.test(t.url));
      await page.until(
        "!!document.querySelector('#capture-shortcut-notice') && !document.querySelector('#capture-shortcut-notice').hidden",
      );
      const state = await page.ev('vsApi.captureList()');
      assert.equal(state.shortcutActive, !!expected);
      if (expected) {
        assert.equal(state.shortcut, expected);
        assert.ok(
          await page.ev(
            `document.querySelector('#capture-shortcut-notice').textContent.includes(${JSON.stringify(expected.replace('+', ' + '))})`,
          ),
        );
      } else assert.match(state.shortcutNotice, /Все сочетания/);
      assert.equal(
        await page.ev('!!window.screenshotEditor'),
        false,
        'Notice must work before visiting screenshots',
      );
      console.log('PASS shortcut fallback:', busy, '=>', expected || 'visible unavailable notice');
    } finally {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    }
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
