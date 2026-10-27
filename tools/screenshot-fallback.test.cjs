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
      JSON.stringify({ dataDir: path.join(tmp, 'data') }),
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
      page.close();
      main.close();
    } finally {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    }
  }
  await customShortcuts();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

async function customShortcuts() {
  const rules = require('../src/capture-shortcut');
  assert.equal(
    rules.fromEvent({ code: 'KeyS', key: 'ы', ctrlKey: true, shiftKey: true }),
    'Control+Shift+S',
  );
  assert.equal(rules.normalize('PrintScreen'), 'PrintScreen');
  assert.match(rules.warning('PrintScreen'), /Windows 11/);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snowball-custom-key-'));
  const profile = path.join(tmp, 'profile');
  fs.mkdirSync(profile);
  fs.writeFileSync(
    path.join(profile, 'settings.json'),
    JSON.stringify({
      dataDir: path.join(tmp, 'data'),
      captureShortcut: 'Alt+B',
      lastVersion: '1.16.3',
    }),
  );
  async function launch(busy, test) {
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
    const exited = new Promise((resolve) => child.once('exit', resolve));
    let main, page;
    try {
      main = await connect(9246, (t) => t.type === 'node');
      page = await connect(9346, (t) => /index\.html/.test(t.url));
      await page.until(
        '!!window.SnowShortcut && !!window.vsApi && !!document.querySelector("#capture-settings-control output")',
      );
      await page.ev("document.querySelectorAll('dialog[open]').forEach(d=>d.close())");
      await test(page, main);
    } finally {
      page?.close();
      main?.close();
      child.kill();
      await exited;
    }
  }
  await launch('Alt+V', async (page, main) => {
    const state = await page.ev('vsApi.captureState()');
    assert.equal(state.shortcut, 'Alt+B', 'Legacy choice survives migration');
    assert.equal(state.shortcutActive, true);
    await page.ev("document.querySelector('[data-page=home]').click()");
    const set = (key) => page.ev(`vsApi.captureShortcut(${JSON.stringify(key)})`);
    assert.equal((await set('Control+Shift+S')).ok, true);
    for (const key of [
      'Control+T',
      'Control+W',
      'Control+Tab',
      'Control+Shift+Tab',
      'Control+K',
      'Control+N',
      ...'C V X Z A S Y F P'.split(' ').map((k) => 'Control+' + k),
      'Shift+S',
      'S',
      'Win+S',
      'Meta+S',
      'Alt+S+B',
      'Control+Control+Q',
      'Alt+Ы',
    ]) {
      assert.equal((await set(key)).ok, false, 'Must reject ' + key);
      assert.equal((await page.ev('vsApi.captureState()')).shortcut, 'Control+Shift+S');
    }
    assert.equal((await set('Alt+V')).error, 'Это сочетание занято другой программой');
    assert.equal(
      await main.ev(
        "process.mainModule.require('electron').globalShortcut.isRegistered('Control+Shift+S')",
      ),
      true,
    );
    await page.until("document.querySelector('.capture-nav kbd').textContent==='Ctrl + Shift + S'");
    assert.equal(
      await page.ev("document.querySelector('#capture-settings-key').textContent"),
      'Ctrl + Shift + S',
    );
    assert.ok(
      await page.ev(
        "document.querySelector('#view-home').textContent.includes('Ctrl + Shift + S')",
      ),
      'Home tile updates immediately',
    );
    await page.ev("document.querySelector('.capture-nav').click()");
    await page.until(
      "!!window.screenshotEditor && document.querySelector('.shot-empty-key').textContent.includes('Ctrl + Shift + S')",
    );
    assert.equal(await page.ev("document.querySelector('.shot-empty-key').textContent"), 'Нажмите «Снять область» или Ctrl + Shift + S.');
    assert.ok(
      await page.ev(
        "document.querySelector('.shot-key-state').textContent.includes('Ctrl + Shift + S')",
      ),
    );
    const begin = async (selector) => {
      await main.ev(
        "(()=>{const w=process.mainModule.require('electron').BrowserWindow.getAllWindows().find(w=>!w.__snowCapture);w.show();w.focus();})()",
      );
      // In «Снимки» the shortcut lives in the «Клавиши» pop-up: open it first, like a person would
      // (recording stops by itself when its field is not visible).
      if (selector === '.shot-key')
        await page.ev("(() => { const p = document.querySelector('.shot-key-pop'); if (p.hidden) document.querySelector('.shot-key-btn').click(); return true; })()");
      await page.ev(
        `document.querySelector(${JSON.stringify(selector + ' .capture-shortcut-change')}).click()`,
      );
      await page.until(
        `document.querySelector(${JSON.stringify(selector + ' output')}).textContent.includes('Нажмите сочетание')`,
      );
    };
    const press = async (code, options = {}, release = true) => {
      await page.ev(
        `window.dispatchEvent(new KeyboardEvent('keydown',${JSON.stringify({ code, bubbles: true, ...options })}))`,
      );
      if (release)
        await page.ev(
          `window.dispatchEvent(new KeyboardEvent('keyup',${JSON.stringify({ code, bubbles: true, ...options })}))`,
        );
    };
    await begin('.shot-key');
    assert.equal(
      await main.ev(
        "process.mainModule.require('electron').globalShortcut.isRegistered('Control+Shift+S')",
      ),
      false,
      'Old hotkey suspended during recording',
    );
    await press('KeyQ', { key: 'й', ctrlKey: true, shiftKey: true });
    await page.until("document.querySelector('.shot-key output').textContent==='Ctrl + Shift + Q'");
    await page.until("document.querySelector('.shot-empty-key').textContent==='Нажмите «Снять область» или Ctrl + Shift + Q.'");
    assert.equal(await page.ev(`(() => { const e = new KeyboardEvent('keydown', { code: 'KeyS', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }); document.dispatchEvent(e); return e.defaultPrevented; })()`), false, 'Unassigned Ctrl + Shift + S must not trigger capture');
    assert.equal((await page.ev('vsApi.captureState()')).shortcut, 'Control+Shift+Q');
    await begin('.shot-key');
    await press('KeyT', { ctrlKey: true });
    assert.ok(
      await page.ev("document.querySelector('.shot-key p').textContent.includes('используется')"),
    );
    await press('Escape');
    await page.until("document.querySelector('.shot-key output').textContent==='Ctrl + Shift + Q'");
    await begin('.shot-key');
    await press('KeyV', { altKey: true });
    await page.until(
      "document.querySelector('.shot-key p').textContent==='Это сочетание занято другой программой'",
    );
    assert.equal(
      await main.ev(
        "process.mainModule.require('electron').globalShortcut.isRegistered('Control+Shift+Q')",
      ),
      true,
    );
    await begin('.shot-key');
    await press('KeyQ', { altKey: true }, false);
    await press('KeyB', { altKey: true }, false);
    assert.ok(
      await page.ev("document.querySelector('.shot-key p').textContent.includes('одну обычную')"),
    );
    await press('Escape');
    await page.ev(
      "document.querySelector('[data-action=settings]').click();document.querySelector('[data-sec=shortcuts]').click()",
    );
    await begin('#capture-settings-control');
    await press('KeyS', { key: 'ы', ctrlKey: true, shiftKey: true });
    await page.until(
      "document.querySelector('#capture-settings-control output').textContent==='Ctrl + Shift + S'",
    );
    await page.until(
      "!document.querySelector('#capture-settings-control .capture-shortcut-reset').disabled",
    );
    // Force a conflict in this test process; an installed Snowball may or may not own Alt+Z.
    assert.equal(await main.ev(`(() => {
      const shortcuts = process.mainModule.require('electron').globalShortcut;
      global.__testRegisterShortcut = shortcuts.register;
      shortcuts.register = (key, callback) => key === 'Alt+Z' ? false : global.__testRegisterShortcut.call(shortcuts, key, callback);
      return shortcuts.register !== global.__testRegisterShortcut;
    })()`), true);
    await page.ev(
      "document.querySelector('#capture-settings-control .capture-shortcut-reset').click()",
    );
    await page.until(
      "!document.querySelector('#capture-settings-control .capture-shortcut-reset').disabled",
    );
    const resetState = await page.ev('vsApi.captureState()');
    assert.equal(await page.ev("document.querySelector('#capture-settings-control p').textContent"), 'Это сочетание занято другой программой');
    assert.equal(resetState.shortcut, 'Control+Shift+S');
    assert.equal(resetState.shortcutActive, true);
    await main.ev(`(() => { const s = process.mainModule.require('electron').globalShortcut; s.register = global.__testRegisterShortcut; return true; })()`);
    console.log('PASS: Alt + Z занят в тесте — прежнее сочетание сохранено');
    await begin('#capture-settings-control');
    await page.ev(
      "window.dispatchEvent(new KeyboardEvent('keyup',{code:'PrintScreen',bubbles:true}))",
    );
    await page.until(
      "!document.querySelector('#capture-settings-control .capture-shortcut-reset').disabled",
    );
    const printState = await page.ev('vsApi.captureState()');
    if (printState.shortcut === 'PrintScreen') {
      assert.ok(
        await page.ev(
          "document.querySelector('#capture-settings-control p').textContent.includes('Windows 11')",
        ),
      );
    } else {
      assert.equal(printState.shortcut, resetState.shortcut);
      assert.equal(
        await page.ev("document.querySelector('#capture-settings-control p').textContent"),
        'Это сочетание занято другой программой',
      );
    }
    assert.equal((await set('Control+Alt+Q')).ok, true);
    await begin('#capture-settings-control');
    await page.ev("document.querySelector('#settings-close').click()");
    await page.until('vsApi.captureState().then(s=>s.shortcutActive && !s.shortcutRecording)');
    assert.equal((await page.ev('vsApi.captureState()')).shortcut, 'Control+Alt+Q');
    await page.ev(
      "document.querySelector('[data-action=settings]').click();document.querySelector('[data-sec=shortcuts]').click()",
    );
    const settingsImage = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(
      path.join(tmp, 'settings.png'),
      Buffer.from(settingsImage.result.data, 'base64'),
    );
    console.log('Settings preview:', path.join(tmp, 'settings.png'));
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'))).captureShortcut,
      'Control+Alt+Q',
    );
    console.log(
      'PASS custom shortcut: physical keys, validation, occupied rollback, Esc, multi-key rejection, Settings, reset, live labels',
    );
  });
  await launch('', async (page) => {
    const state = await page.ev('vsApi.captureState()');
    assert.equal(state.shortcut, 'Control+Alt+Q');
    assert.equal(state.shortcutActive, true);
    console.log('PASS custom shortcut survives restart');
  });
  await launch('Control+Alt+Q', async (page) => {
    const state = await page.ev('vsApi.captureState()');
    assert.equal(state.shortcut, 'Control+Alt+Q');
    assert.equal(state.shortcutActive, false);
    assert.match(state.shortcutNotice, /Выберите другое/);
    await page.until("!document.querySelector('#capture-shortcut-notice').hidden");
    console.log('PASS occupied saved shortcut is kept; sidebar warning is visible');
  });
}
