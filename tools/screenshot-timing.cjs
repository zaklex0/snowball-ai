'use strict';
// How long a capture takes from the shortcut to the frozen screen. Real Electron, real screen, isolated profile.
// node tools/screenshot-timing.cjs [rounds]. The screen picture stays in memory: every capture is cancelled with Esc.
const fs = require('fs'), path = require('path'), os = require('os'), { spawn } = require('child_process');
const { connect, sleep } = require('./guide-shots/cdp');
const root = path.resolve(__dirname, '..'), rounds = Number(process.argv[2]) || 5;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snowball-shot-timing-')), profile = path.join(tmp, 'profile');
fs.mkdirSync(profile);
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ dataDir: path.join(tmp, 'data'), theme: 'light', lastVersion: '99.0.0', captureShortcut: 'Alt+Shift+F12', captureShortcutInitialized: true }));
const child = spawn(require('electron'), [root, '--inspect=9246', '--remote-debugging-port=9346', '--user-data-dir=' + profile], {
  cwd: root, env: { ...process.env, SNOWBALL_CAPTURE_TIMING: '1' }, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
});
const logs = [];
child.stdout.on('data', (d) => d.toString().split(/\r?\n/).filter((l) => l.includes('[capture timing]')).forEach((l) => logs.push(l)));
process.on('exit', () => { try { child.kill(); } catch {} });

(async () => {
  const main = await connect(9246, (t) => t.type === 'node');
  const page = await connect(9346, (t) => t.type === 'page' && /index\.html/.test(t.url));
  await page.until('!!window.vsApi');
  await sleep(1500);
  const totals = [];
  for (let i = 0; i < rounds; i++) {
    const before = logs.length;
    await main.ev('global.snowCaptureStart().then(() => true)');
    const overlays = [];
    const list = await (await fetch('http://127.0.0.1:9346/json/list')).json();
    for (const t of list.filter((t) => /capture-overlay\.html/.test(t.url))) overlays.push(await connect(9346, (x) => x.id === t.id));
    let shown = 0;
    for (const o of overlays) { await o.until('!!window.captureShownAt', 10000); shown = Math.max(shown, await o.ev('window.captureShownAt')); }
    const started = Number(/start (\d+)/.exec(logs.slice(before).find((l) => / start /.test(l)))[1]);
    totals.push(shown - started);
    console.log(`#${i + 1}: ${shown - started} ms до готового экрана выделения`);
    logs.slice(before).forEach((l) => console.log('   ' + l.replace('[capture timing] ', '')));
    await overlays[0].send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    overlays.forEach((o) => o.close());
    await sleep(600);
  }
  const sorted = totals.slice().sort((a, b) => a - b);
  console.log('Медиана: ' + sorted[Math.floor(sorted.length / 2)] + ' ms, первый: ' + totals[0] + ' ms');
  main.close();
  process.exit(0);
})().catch((e) => { console.error(e.stack); process.exit(1); });
