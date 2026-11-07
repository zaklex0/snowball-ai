'use strict';
// Simulate a disconnected data folder; both the profile and the Documents fallback are test directories.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { connect } = require('./guide-shots/cdp');

(async () => {
  const root = path.resolve(__dirname, '..'), tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-disconnect-'));
  const profile = path.join(tmp, 'profile'), docs = path.join(tmp, 'documents'), unavailable = path.join(tmp, 'disconnected'), fallback = path.join(docs, 'Snowball.ai');
  await fs.mkdir(profile); await fs.mkdir(docs); await fs.mkdir(fallback);
  await fs.writeFile(path.join(profile, 'settings.json'), JSON.stringify({ dataDir: unavailable }));
  await fs.writeFile(path.join(fallback, 'profile.json'), JSON.stringify({ name: 'Тест', welcomed: true }));
  const helper = path.join(tmp, 'isolate-test.cjs');
  await fs.writeFile(helper, `
    if (process.type === 'browser') {
      const Module = require('module'), fs = require('fs').promises, path = require('path');
      const load = Module._load;
      Module._load = function(request, parent, isMain) {
        const result = load.apply(this, arguments);
        if (request === 'electron' && result && result.app) {
          result.app.setPath('documents', ${JSON.stringify(docs)});
          Module._load = load;
        }
        return result;
      };
      const mkdir = fs.mkdir;
      fs.mkdir = async (p, options) => {
        if (path.resolve(p) === ${JSON.stringify(path.resolve(unavailable))}) {
          const e = new Error('test drive unavailable'); e.code = 'ENOENT'; throw e;
        }
        return mkdir(p, options);
      };
    }
  `);
  const child = spawn(require('electron'), ['.', '--inspect=9272', '--remote-debugging-port=9372', '--user-data-dir=' + profile],
    { cwd: root, env: { ...process.env, NODE_OPTIONS: '--require="' + helper.replace(/\\/g, '/') + '"' }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let errors = '';
  child.stderr.on('data', (s) => { errors += s; });
  try {
    const main = await Promise.race([connect(9272, (t) => t.type === 'node'), new Promise((_, reject) => child.once('exit', () => reject(new Error('Test app exited: ' + errors))))]);
    assert.equal(path.resolve(await main.ev("process.mainModule.require('electron').app.getPath('userData')")), path.resolve(profile));
    assert.equal(path.resolve(await main.ev("process.mainModule.require('electron').app.getPath('documents')")), path.resolve(docs));
    const page = await connect(9372, (t) => /index\.html/.test(t.url));
    await page.until('!!window.vsApi && document.readyState === "complete"');
    assert.equal(path.resolve((await page.ev('vsApi.load()')).info.dataDir), path.resolve(fallback));
    assert.equal(path.resolve(JSON.parse(await fs.readFile(path.join(profile, 'settings.json'), 'utf8')).dataDir), path.resolve(unavailable));
    await main.ev(`process.mainModule.require('electron').dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(fallback)}]}); true`);
    const selected = await page.ev('vsApi.changeDataDir()');
    assert.equal(selected.ok, true);
    assert.equal(selected.canceled, undefined);
    assert.equal(path.resolve(JSON.parse(await fs.readFile(path.join(profile, 'settings.json'), 'utf8')).dataDir), path.resolve(fallback));
    page.close(); main.close();
    console.log('OK: a disconnected folder remains the preferred location until the user explicitly chooses the fallback');
  } finally {
    child.kill();
    await new Promise((resolve) => child.exitCode !== null ? resolve() : child.once('exit', resolve));
    await fs.rm(tmp, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
