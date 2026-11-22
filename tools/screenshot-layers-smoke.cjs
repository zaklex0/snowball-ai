'use strict';
// Real editor and storage, generated pictures, isolated profile; never capture the user's desktop.
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('node:assert/strict');
const { spawn } = require('child_process');
const { connect, freePort } = require('./guide-shots/cdp');
const root = path.resolve(__dirname, '..'), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snowball-layers-'));
const profile = path.join(tmp, 'profile'), data = path.join(tmp, 'data');
fs.mkdirSync(profile);
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ dataDir: data, theme: 'light', lastVersion: '1.24.0', profile: { name: 'Гость' }, bounds: { width: 1440, height: 920 } }));
let child, main, page;
const mouse = (type, x, y, extra = {}) => page.send('Input.dispatchMouseEvent', { type, x, y, ...extra });
const click = (selector) => page.ev(`document.querySelector(${JSON.stringify(selector)}).click()`);
const flush = async () => assert.equal(await page.ev('window.screenshotEditor.flush()'), true);
async function rect() {
  return page.ev("(()=>{const r=document.querySelector('.shot-stage canvas').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()");
}
async function drag(tool, a, b) {
  await click('[data-tool=' + tool + ']');
  const r = await rect();
  await mouse('mousePressed', r.x + r.w * a[0], r.y + r.h * a[1], { button: 'left', clickCount: 1 });
  await mouse('mouseMoved', r.x + r.w * b[0], r.y + r.h * b[1], { button: 'left', buttons: 1 });
  await mouse('mouseReleased', r.x + r.w * b[0], r.y + r.h * b[1], { button: 'left', clickCount: 1 });
}
const input = (selector, value) => page.ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
process.on('exit', () => { try { child?.kill(); } catch {} });
(async () => {
  const inspect = await freePort(), remote = await freePort();
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(require('electron'), [process.argv[2] ? path.resolve(process.argv[2]) : root, '--inspect=' + inspect, '--remote-debugging-port=' + remote, '--user-data-dir=' + profile], { cwd: root, env, stdio: 'ignore', windowsHide: true });
  main = await connect(inspect, (t) => t.type === 'node');
  assert.equal(path.resolve(await main.ev("process.mainModule.require('electron').app.getPath('userData')")), profile);
  await main.ev("global.layerElectron=process.mainModule.require('electron');true");
  page = await connect(remote, (t) => t.type === 'page' && /index\.html/.test(t.url));
  await page.until("document.readyState==='complete' && !!document.querySelector('.tab.on')");
  await page.ev("document.querySelectorAll('dialog[open]').forEach(d=>d.close());document.querySelector('.capture-nav').click()");
  await page.until('!!window.screenshotEditor');
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const png = await page.ev("(()=>{const c=document.createElement('canvas');c.width=900;c.height=580;const g=c.getContext('2d');g.fillStyle='#ffffff';g.fillRect(0,0,900,580);g.fillStyle='#315542';g.font='28px sans-serif';g.fillText('План проекта — пример',60,60);return c.toDataURL('image/png').split(',')[1]})()");
    const file = path.join(tmp, 'fixture-' + i + '.png');
    fs.writeFileSync(file, Buffer.from(png, 'base64'));
    await main.ev(`layerElectron.dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(file)}]});true`);
    const result = await page.ev('vsApi.captureImport()');
    assert.equal(result.ok, true, result.error);
    ids.push(result.id);
  }
  await page.ev(`screenshotEditor.refresh().then(()=>screenshotEditor.open(${JSON.stringify(ids[0])}))`);
  const token = (await page.ev('vsApi.captureList()')).token;
  const get = async (id = ids[0]) => (await page.ev(`vsApi.captureGet(${JSON.stringify(id)},${JSON.stringify(token)})`)).item;
  const original = fs.readFileSync(path.join(data, 'Снимки', ids[0], 'original.png'));
  await drag('pen', [.1, .2], [.6, .2]);
  await drag('rect', [.15, .35], [.55, .65]);
  await drag('text', [.15, .75], [.75, .92]);
  await page.send('Input.insertText', { text: 'Проверить кнопку' });
  await flush();
  assert.deepEqual((await get()).ops.map((o) => o.number), [1, 2, 3]);
  assert.equal(await page.ev("document.querySelectorAll('.shot-layer').length"), 3);
  assert.equal(await page.ev("document.querySelector('.shot-layer-pick').dataset.layerPick"), '3');
  // Each visibility switch affects the real rendering and persists after reopening.
  const pixel = () => page.ev("Array.from(document.querySelector('.shot-stage canvas').getContext('2d').getImageData(300,116,1,1).data)");
  const shown = await pixel();
  assert.notDeepEqual(shown, [255, 255, 255, 255]);
  await click('[data-layer-eye="1"]');
  assert.deepEqual(await pixel(), [255, 255, 255, 255]);
  await flush();
  await page.ev(`screenshotEditor.open(${JSON.stringify(ids[0])})`);
  assert.equal((await get()).ops[0].hidden, true);
  await click('[data-layer-eye="1"]');
  assert.deepEqual(await pixel(), shown);
  await input('.shot-layer-color', '#2244aa');
  await input('.shot-layer-width', '12');
  await flush();
  assert.equal((await get()).ops[0].color, '#2244aa');
  assert.equal((await get()).ops[0].width, 12);
  await click('[data-action=undo]'); await flush();
  assert.equal((await get()).ops[0].width, 5);
  await click('[data-action=redo]'); await flush();
  assert.equal((await get()).ops[0].width, 12);
  // Reordering preserves layer numbers; undo restores the entire order.
  await click('[data-layer-action=up]'); await flush();
  assert.deepEqual((await get()).ops.map((o) => o.number), [2, 1, 3]);
  await click('[data-action=undo]'); await flush();
  assert.deepEqual((await get()).ops.map((o) => o.number), [1, 2, 3]);
  await click('[data-layer-pick="3"]');
  await input('.shot-layer-text', 'Изменённая надпись'); await flush();
  assert.equal((await get()).ops[2].text, 'Изменённая надпись');
  await click('[data-action=undo]'); await flush();
  assert.equal((await get()).ops[2].text, 'Проверить кнопку');
  // Move a pen by grabbing the stroke, rather than its bounding rectangle.
  const beforeMove = (await get()).ops[0].points;
  await drag('select', [.3, .2], [.4, .3]); await flush();
  let moved = (await get()).ops[0].points;
  assert.ok(Math.abs(moved[0].x - beforeMove[0].x - 90) < 2);
  assert.ok(Math.abs(moved[0].y - beforeMove[0].y - 58) < 2);
  await click('[data-action=undo]'); await flush();
  assert.deepEqual((await get()).ops[0].points, beforeMove);
  // Pointer cancellation discards the move preview and does not change stored geometry.
  const r = await rect();
  await mouse('mousePressed', r.x + .3 * r.w, r.y + .2 * r.h, { button: 'left', clickCount: 1 });
  await mouse('mouseMoved', r.x + .4 * r.w, r.y + .3 * r.h, { button: 'left', buttons: 1 });
  await page.ev("document.querySelector('.shot-stage canvas').dispatchEvent(new PointerEvent('pointercancel',{bubbles:true}))");
  await mouse('mouseReleased', r.x + .4 * r.w, r.y + .3 * r.h, { button: 'left', clickCount: 1 });
  await flush();
  assert.deepEqual((await get()).ops[0].points, beforeMove);
  await click('[data-layer-pick="3"]'); await click('[data-layer-action=remove]'); await flush();
  assert.deepEqual((await get()).ops.map((o) => o.number), [1, 2]);
  await drag('marker', [.1, .5], [.6, .5]); await flush();
  assert.deepEqual((await get()).ops.map((o) => o.number), [1, 2, 4]);
  // Layer state is independent per image and after a page reload (fresh renderer state).
  await page.ev(`screenshotEditor.open(${JSON.stringify(ids[1])})`);
  assert.equal(await page.ev("document.querySelectorAll('.shot-layer').length"), 0);
  await page.ev('window.__layerReloading=true');
  await page.send('Page.reload');
  await page.until("!window.__layerReloading && document.readyState==='complete' && !!document.querySelector('.tab.on')");
  await page.ev("document.querySelectorAll('dialog[open]').forEach(d=>d.close());document.querySelector('.capture-nav').click()");
  await page.until("!!window.screenshotEditor && document.querySelector('.shot-count').textContent === '2'");
  await page.ev(`screenshotEditor.open(${JSON.stringify(ids[0])})`);
  assert.deepEqual((await get()).ops.map((o) => o.number), [1, 2, 4]);
  // Hidden erasers stop erasing. A selected-layer frame never appears in export rendering.
  await drag('eraser', [1 / 3, .16], [1 / 3, .24]); await flush();
  assert.deepEqual(await pixel(), [255, 255, 255, 255]);
  await click('[data-layer-eye="5"]'); await flush();
  assert.notDeepEqual(await pixel(), [255, 255, 255, 255]);
  // Move after cropping uses original-image coordinates and undo restores the crop as well.
  await drag('crop', [.05, .1], [.8, .95]);
  await click('[data-action=apply-crop]'); await flush();
  const cropped = await get();
  assert.ok(cropped.crop);
  await drag('select', [.25, .118], [.35, .218]); await flush();
  moved = (await get()).ops[0].points;
  assert.ok(Math.abs(moved[0].x - beforeMove[0].x - cropped.crop.width * .1) < 3);
  await click('[data-action=undo]'); await flush();
  assert.deepEqual((await get()).ops[0].points, beforeMove);
  await click('[data-action=undo]'); await flush();
  assert.equal((await get()).crop, null);
  assert.deepEqual(fs.readFileSync(path.join(data, 'Снимки', ids[0], 'original.png')), original);
  // Selection outlines belong only to the editor, not to the exported PNG.
  await click('[data-layer-pick="2"]');
  const expectedPng = await page.ev(`(async()=>{const {item}=await vsApi.captureGet(${JSON.stringify(ids[0])},${JSON.stringify(token)});const img=new Image();img.src=item.url;await img.decode();const c=document.createElement('canvas');c.width=item.width;c.height=item.height;SnowCapture.paint(c.getContext('2d'),img,item.ops,item.blur);return c.toDataURL('image/png')})()`);
  const exported = path.join(tmp, 'layers.png');
  await main.ev(`layerElectron.dialog.showSaveDialog=async()=>({canceled:false,filePath:${JSON.stringify(exported)}});true`);
  await click('.capture-app [data-action=export]');
  await page.until("document.querySelector('.shot-status').textContent==='Снимок сохранён.'");
  assert.equal(await main.ev(`layerElectron.nativeImage.createFromPath(${JSON.stringify(exported)}).toBitmap().equals(layerElectron.nativeImage.createFromDataURL(${JSON.stringify(expectedPng)}).toBitmap())`), true);
  // A focus border participates in layer order; its background effect can be hidden.
  await drag('focus', [.2, .2], [.5, .4]); await flush();
  await click('[data-layer-pick="6"]');
  await input('.shot-layer-blur', '25'); await flush();
  assert.equal((await get()).blur, 25);
  const focusTop = await pixel();
  await click('[data-layer-action=down]');
  await click('[data-layer-action=down]');
  await click('[data-layer-action=down]');
  await click('[data-layer-action=down]'); await flush();
  assert.notDeepEqual(await pixel(), focusTop);
  assert.equal((await get()).ops[0].number, 6);
  await click('[data-layer-eye="6"]'); await flush();
  assert.equal((await get()).ops[0].hidden, true);
  // Actual UI layouts, including light/dark macOS and a small separate editor.
  for (const [theme, look] of [['light'], ['dark'], ['macos', 'light'], ['macos', 'dark']]) {
    if (look) {
      await click('#menu button[data-look="' + look + '"]');
      await page.until(`document.documentElement.dataset.theme==='macos' && matchMedia('(prefers-color-scheme: dark)').matches===${look === 'dark'}`);
    } else {
      await click('#menu button[data-theme="' + theme + '"]');
      await page.until(`!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches===${theme === 'dark'}`);
    }
    await page.ev("document.documentElement.classList.remove('glass')");
    await page.sleep(150);
    assert.equal(await page.ev("(()=>{const p=document.querySelector('.shot-layers').getBoundingClientRect(), c=document.querySelector('.shot-stage canvas').getBoundingClientRect();return p.width>150 && p.right<=innerWidth && c.width>100 && c.height>50})()"), true);
    const image = await page.send('Page.captureScreenshot', { format: 'png' });
    const out = path.join(process.env.SNOWBALL_TEST_OUTPUT || path.join(root, 'mockups'), 'screenshot-layers-implemented-' + theme + (look ? '-' + look : '') + '.png');
    fs.writeFileSync(out, Buffer.from(image.result.data, 'base64'));
  }
  await click('#menu button[data-theme="light"]');
  await page.until("!document.documentElement.dataset.theme && !matchMedia('(prefers-color-scheme: dark)').matches");
  await click('[data-pop=help]');
  await click('.capture-app [data-guide=screenshots]');
  await page.until("!!document.querySelector('.guide-dlg[open]')");
  await click('.gd-dots button[title*="Слои каждого"]');
  await page.until("document.querySelector('.gd-pic img')?.naturalWidth===1280");
  const guide = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(process.env.SNOWBALL_TEST_OUTPUT || path.join(root, 'mockups'), 'screenshot-layers-guide.png'), Buffer.from(guide.result.data, 'base64'));
  await click('.gd-x');
  await main.ev("layerElectron.BrowserWindow.getAllWindows().find(w=>!w.__snowCapture).setContentSize(790,720);true");
  await page.send('Emulation.setDeviceMetricsOverride', { width: 650, height: 720, deviceScaleFactor: 1, mobile: false });
  await page.sleep(250);
  assert.equal(await page.ev("(()=>{const e=document.querySelector('.shot-editor-body').getBoundingClientRect();return e.width>100 && e.right<=innerWidth})()"), true);
  assert.equal(await page.ev("(()=>{const p=document.querySelector('.shot-layers').getBoundingClientRect(),s=document.querySelector('.shot-stage').getBoundingClientRect();return p.top>=s.bottom-1})()"), true);
  const narrow = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(process.env.SNOWBALL_TEST_OUTPUT || path.join(root, 'mockups'), 'screenshot-layers-narrow.png'), Buffer.from(narrow.result.data, 'base64'));
  console.log('Screenshot layers: visibility, geometry, properties, order, undo/redo, crop, reload and themes passed.');
  page.close(); main.close(); child.kill();
  process.exit(0);
})().catch(async (e) => {
  console.error(e);
  if (page) {
    try { console.error('Editor status:', await page.ev("document.querySelector('.shot-status')?.textContent")); } catch {}
  }
  console.error('Isolated test folder:', tmp);
  process.exit(1);
});
