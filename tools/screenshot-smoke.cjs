'use strict';
// Real Electron, isolated profile. The desktop capture is covered by synthetic test windows.
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('node:assert/strict'), { spawn } = require('child_process');
const { connect } = require('./guide-shots/cdp');
const root = path.resolve(__dirname, '..'), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snowball-shot-smoke-')), profile = path.join(tmp, 'profile'), data = path.join(tmp, 'data');
fs.mkdirSync(profile); fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ dataDir: data, theme: 'light', lastVersion: '1.16.2', bounds: { width: 1280, height: 900 } }));
const appPath = process.argv[3] ? path.resolve(process.argv[3]) : root;
const child = spawn(require('electron'), [appPath, '--inspect=9245', '--remote-debugging-port=9345', '--user-data-dir=' + profile], { cwd: root, stdio: 'ignore', windowsHide: true });
process.on('exit', () => { try { child.kill(); } catch {} });
let main;
async function mouse(page, type, x, y, extra = {}) { await page.send('Input.dispatchMouseEvent', { type, x, y, ...extra }); }
async function draw(page, tool, from, to) {
  await page.ev(`document.querySelector('[data-tool="${tool}"]').click()`);
  const r = await page.ev("(() => { const r=document.querySelector('.shot-stage canvas').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}; })()");
  await mouse(page, 'mousePressed', r.x + r.w * from[0], r.y + r.h * from[1], { button: 'left', clickCount: 1 });
  await mouse(page, 'mouseMoved', r.x + r.w * to[0], r.y + r.h * to[1], { button: 'left', buttons: 1 });
  await mouse(page, 'mouseReleased', r.x + r.w * to[0], r.y + r.h * to[1], { button: 'left', clickCount: 1 });
}
(async () => {
  main = await connect(9245, t => t.type === 'node');
  assert.equal(path.resolve(await main.ev("process.mainModule.require('electron').app.getPath('userData')")), profile);
  await main.ev("global.shotTestElectron=process.mainModule.require('electron'); global.shotOldClipboard={text:shotTestElectron.clipboard.readText(),html:shotTestElectron.clipboard.readHTML(),image:shotTestElectron.clipboard.readImage()}; true");
  const page = await connect(9345, t => t.type === 'page' && /index\.html/.test(t.url));
  await page.until("!!window.vsApi && !!document.querySelector('.capture-nav')");
  await page.ev("document.querySelectorAll('dialog[open]').forEach(d=>d.close());document.querySelector('.capture-nav').click()");
  await page.until('!!window.screenshotEditor');
  const initial = await page.ev('window.vsApi.captureList()'); assert.equal(initial.ok, true); assert.equal(initial.items.length, 0);
  // Save two generated image files through the real import endpoint.
  for (let i = 0; i < 2; i++) {
    const file = path.join(tmp, 'fixture-' + i + '.png');
    const png = await page.ev(`(() => {const c=document.createElement('canvas');c.width=${i ? 640 : 900};c.height=${i ? 360 : 560};const g=c.getContext('2d');g.fillStyle='#d9e8e1';g.fillRect(0,0,c.width,c.height);g.fillStyle='#477363';g.fillRect(60,70,220,130);g.fillStyle='#fff9f4';g.fillRect(320,70,220,130);g.fillStyle='#253f36';g.font='36px sans-serif';g.fillText('Снимок ${i + 1}',60,270);return c.toDataURL('image/png').split(',')[1]})()`);
    fs.writeFileSync(file, Buffer.from(png, 'base64'));
    await main.ev(`shotTestElectron.dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(file)}]});true`);
    const result = await page.ev('window.vsApi.captureImport()'); assert.equal(result.ok, true, result.error);
  }
  await page.ev('window.screenshotEditor.refresh()');
  let list = await page.ev('window.vsApi.captureList()'); const ids = list.items.map(s => s.id);
  await page.ev(`window.screenshotEditor.open(${JSON.stringify(ids[0])})`);
  await draw(page, 'marker', [.1, .2], [.5, .2]);
  await draw(page, 'rect', [.05, .1], [.45, .6]);
  await draw(page, 'focus', [.05, .1], [.45, .6]);
  await draw(page, 'text', [.12, .7], [.8, .9]);
  await page.send('Input.insertText', { text: 'Текст в области' });
  assert.equal(await page.ev('window.screenshotEditor.flush()'), true);
  let shot = await page.ev(`window.vsApi.captureGet(${JSON.stringify(ids[0])},${JSON.stringify(list.token)})`);
  assert.deepEqual(shot.item.ops.map(o => o.type), ['marker', 'rect', 'focus', 'text']); assert.equal(shot.item.ops[3].text, 'Текст в области');
  // Per-card copy must not switch the editor or discard pending text.
  const activeSize = await page.ev("({w:document.querySelector('.shot-stage canvas').width,h:document.querySelector('.shot-stage canvas').height})");
  await page.ev(`document.querySelector('[data-id="${ids[1]}"] .shot-copy').click()`);
  await page.until("document.querySelector('.shot-status').textContent.includes('скопирован')");
  const other = list.items.find(s => s.id === ids[1]); assert.deepEqual(await main.ev('shotTestElectron.clipboard.readImage().getSize()'), { width: other.width, height: other.height });
  assert.equal(await page.ev("document.querySelector('.shot-stage canvas').width"), activeSize.w);
  // Stale revision rejected, current revision and originals survive reopening.
  const stale = await page.ev(`window.vsApi.captureSave(${JSON.stringify(ids[0])},${JSON.stringify(list.token)},{revision:0,ops:[],blur:0})`); assert.equal(stale.ok, false);
  await page.ev(`window.screenshotEditor.open(${JSON.stringify(ids[0])})`);
  assert.equal((await page.ev(`window.vsApi.captureGet(${JSON.stringify(ids[0])},${JSON.stringify(list.token)})`)).item.ops.length, 4);
  // Key choice persists and the old shortcut is released.
  const alt = await page.ev("window.vsApi.captureShortcut('Alt+B')"); assert.equal(alt.ok, true, alt.error);
  assert.equal(await main.ev("shotTestElectron.globalShortcut.isRegistered('Alt+B')"), true);
  assert.equal(await main.ev("shotTestElectron.globalShortcut.isRegistered('Alt+Z')"), false);
  assert.equal(await page.ev("document.querySelector('#capture-settings-key').textContent"), 'Alt + B');
  await main.ev("shotTestElectron.globalShortcut.register('Alt+V',()=>{});true");
  assert.equal((await page.ev("window.vsApi.captureShortcut('Alt+V')")).ok, false);
  assert.equal(await main.ev("shotTestElectron.globalShortcut.isRegistered('Alt+B')"), true);
  await main.ev("shotTestElectron.globalShortcut.unregister('Alt+V');true");
  // Use synthetic screen sources in this regression suite: user activity must never enter artifacts.
  // The overlay, cropping, multi-monitor geometry and window lifecycle still run in real Electron.
  await main.ev(`shotTestElectron.desktopCapturer.getSources=async()=>shotTestElectron.screen.getAllDisplays().map(d=>({display_id:String(d.id),thumbnail:shotTestElectron.nativeImage.createFromPath(${JSON.stringify(path.join(tmp,'fixture-0.png'))}).resize({width:Math.round(d.size.width*d.scaleFactor),height:Math.round(d.size.height*d.scaleFactor)})}));true`);
  await main.ev("(async()=>{global.shotCovers=[];for(const d of shotTestElectron.screen.getAllDisplays()){const w=new shotTestElectron.BrowserWindow({...d.bounds,frame:false,skipTaskbar:true,alwaysOnTop:true,enableLargerThanScreen:true,webPreferences:{sandbox:true}});w.__snowCapture='fixture';await w.loadURL('data:text/html,<body style=\"margin:0;background:rgb(45,105,85);color:white;font:48px sans-serif;padding:70px\">Snowball capture test</body>');w.setBounds(d.bounds);w.show();shotCovers.push(w);}return true;})()");
  const started = await page.ev('window.vsApi.captureStart()'); assert.equal(started.ok, true, started.error);
  const overlay = await connect(9345, t => /capture-overlay\.html/.test(t.url));
  await overlay.until("document.querySelector('#screen').complete && document.querySelector('#screen').naturalWidth>0");
  await mouse(overlay, 'mousePressed', 100, 100, { button: 'left', clickCount: 1, modifiers: 8 });
  await mouse(overlay, 'mouseMoved', 400, 260, { button: 'left', buttons: 1, modifiers: 8 });
  // Do not await a renderer request which closes its own window.
  await mouse(overlay, 'mouseReleased', 400, 260, { button: 'left', clickCount: 1, modifiers: 8 });
  const editor = await connect(9345, t => /capture-editor\.html/.test(t.url));
  await editor.until("!!document.querySelector('.shot-stage canvas') && !document.querySelector('.shot-stage canvas').hidden");
  const captured = await editor.ev('window.vsApi.captureList()'); assert.equal(captured.items.length, 3);
  assert.equal(captured.items[0].width, captured.items[0].height); assert.ok(captured.items[0].width >= 300);
  // Escape leaves the history untouched and restores the requesting window.
  assert.equal((await page.ev('window.vsApi.captureStart()')).ok, true);
  const canceledOverlay = await connect(9345, t => /capture-overlay\.html/.test(t.url));
  await canceledOverlay.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.sleep(150);
  assert.equal((await page.ev('window.vsApi.captureList()')).items.length, 3);
  assert.equal(await main.ev("shotTestElectron.BrowserWindow.getAllWindows().filter(w=>w.__snowCapture==='overlay').length"), 0);
  if (!await main.ev("shotTestElectron.BrowserWindow.getAllWindows().find(w=>!w.__snowCapture).isVisible()")) {
    throw Error('Window visibility: '+JSON.stringify(await main.ev("shotTestElectron.BrowserWindow.getAllWindows().map(w=>({type:w.__snowCapture,url:w.webContents.getURL(),visible:w.isVisible(),minimized:w.isMinimized(),bounds:w.getBounds()}))")));
  }
  assert.equal((await page.ev('window.vsApi.captureStart()')).ok, true);
  const fullOverlay = await connect(9345, t => /capture-overlay\.html/.test(t.url));
  await fullOverlay.until("document.querySelector('#screen').complete && document.querySelector('#screen').naturalWidth>0");
  const fullSize = await fullOverlay.ev("({width:document.querySelector('#screen').naturalWidth,height:document.querySelector('#screen').naturalHeight})");
  await mouse(fullOverlay, 'mousePressed', 100, 100, { button: 'right', clickCount: 1 });
  await mouse(fullOverlay, 'mouseReleased', 100, 100, { button: 'right', clickCount: 1 });
  await page.until("document.querySelector('.shot-count').textContent==='4'");
  const full = (await page.ev('window.vsApi.captureList()')).items[0]; assert.deepEqual({ width: full.width, height: full.height }, fullSize);
  await main.ev('shotCovers.forEach(w=>w.destroy());true');
  // Main app remains intact; changing theme also updates the standalone editor.
  await page.ev("window.vsApi.setTheme('zaklex')");
  await editor.until("document.documentElement.dataset.theme==='zaklex'");
  const out = process.argv[2] || tmp; fs.mkdirSync(out, { recursive: true });
  for (const theme of ['system', 'light', 'dark', 'white', 'black', 'zaklex']) {
    await page.ev(`document.querySelector('button[data-theme="${theme}"]').click()`); await page.sleep(150);
    const bg = "getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()";
    assert.equal(await page.ev(bg), await editor.ev(bg), theme + ' differs between windows');
    if (theme === 'zaklex') {
      assert.deepEqual(await editor.ev("(()=>{const b=document.querySelector('.shot-capture'),r=b.getBoundingClientRect();return [r.width,r.height,getComputedStyle(b).backgroundColor,getComputedStyle(document.querySelector('.shot-tip')).color]})()"), [42,42,'rgb(225, 51, 43)','rgb(240, 227, 206)']);
    }
    for (const [name,target] of [['main',page],['editor',editor]]) { const png=await target.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,`theme-${theme}-${name}.png`),Buffer.from(png.result.data,'base64')); }
  }
  for (const [name, target] of [['screenshots-zaklex', editor], ['screenshots-light', page]]) {
    if (name === 'screenshots-light') { await page.ev("document.querySelector('button[data-theme=light]').click()"); await page.ev(`window.screenshotEditor.open(${JSON.stringify(ids[0])})`); }
    await target.sleep(250); const png = await target.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(png.result.data, 'base64'));
  }
  // Complete real backup through the main app; the immutable original and metadata must be there.
  const backup = path.join(tmp, 'backup.snowball'); await main.ev(`shotTestElectron.dialog.showSaveDialog=async()=>({canceled:false,filePath:${JSON.stringify(backup)}});true`);
  const backupResult = await page.ev('window.vsApi.backupExport()'); assert.equal(backupResult.ok, true, backupResult.error); assert.equal(backupResult.counts.screenshots, 4);
  const { extractZip } = require('../archive'); const unpacked = path.join(tmp, 'unpacked'); await extractZip(backup, unpacked); assert.equal(fs.readdirSync(path.join(unpacked, 'screenshots')).length, 4);
  // Delete goes through shell.trashItem; undo restores the exact bytes and annotations.
  const original = fs.readFileSync(path.join(data,'Снимки',ids[1],'original.png'));
  await page.ev(`document.querySelector('[data-id="${ids[1]}"] .shot-delete').click()`);
  await page.until("!document.querySelector('.shot-toast').hidden && document.querySelector('.shot-count').textContent==='3'");
  assert.equal(fs.existsSync(path.join(data,'Снимки',ids[1])), false);
  await page.ev("document.querySelector('.shot-toast button').click()");
  await page.until("document.querySelector('.shot-count').textContent==='4'");
  assert.deepEqual(fs.readFileSync(path.join(data,'Снимки',ids[1],'original.png')),original);
  const deleted = await page.ev(`window.vsApi.captureDelete(${JSON.stringify(ids[1])},${JSON.stringify(list.token)})`); assert.equal(deleted.ok,true,deleted.error);
  await page.sleep(7150);
  assert.equal((await page.ev(`window.vsApi.captureRestore(${JSON.stringify(deleted.undo)},${JSON.stringify(list.token)})`)).ok,false);
  await main.ev('shotTestElectron.dialog.showMessageBox=async()=>({response:0});true');
  assert.equal((await page.ev(`window.vsApi.archiveOpen(${JSON.stringify(backup)})`)).ok,true);
  assert.equal((await page.ev('window.vsApi.captureList()')).items.length,4);
  const activity = (await page.ev('window.vsApi.load()')).activity;
  assert.equal(Object.values(activity.days).reduce((n,d)=>n+(d.screenshots||0),0),5);
  await page.ev("document.querySelector('[data-guide=screenshots]').click()");
  await page.until("!!document.querySelector('dialog.guide-dlg[open]')");
  assert.equal(await page.ev("document.querySelector('dialog.guide-dlg img').complete && document.querySelector('dialog.guide-dlg img').naturalWidth>0"),true);
  const guidePng=await page.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'screenshots-guide.png'),Buffer.from(guidePng.result.data,'base64'));
  await page.ev("document.querySelector('dialog.guide-dlg').close()");
  await editor.ev("document.querySelector('[data-guide=screenshots]').click()");
  await page.until("!!document.querySelector('dialog.guide-dlg[open]')");
  await page.ev("document.querySelector('dialog.guide-dlg').close()");
  const nextDir = path.join(tmp, 'moved');
  await main.ev(`shotTestElectron.dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(nextDir)}]});true`);
  const moved = await page.ev('window.vsApi.changeDataDir()'); assert.equal(moved.ok, true, moved.error);
  const movedList = await page.ev('window.vsApi.captureList()'); assert.equal(movedList.items.length, 4); assert.notEqual(movedList.token, list.token);
  assert.equal((await page.ev(`window.vsApi.captureSave(${JSON.stringify(ids[0])},${JSON.stringify(list.token)},{revision:0,ops:[],blur:0})`)).ok, false);
  assert.equal(fs.readdirSync(path.join(nextDir, 'Снимки')).length, 4);
  await editor.ev(`window.screenshotEditor.refresh().then(()=>window.screenshotEditor.open(${JSON.stringify(ids[0])}))`);
  const beforeClose = JSON.parse(fs.readFileSync(path.join(nextDir,'Снимки',ids[0],'meta.json'),'utf8')).ops.length;
  await draw(editor,'pen',[.05,.05],[.2,.1]);
  const exited = new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('App stayed alive with only the screenshot editor')),10000);child.once('exit',()=>{clearTimeout(timeout);resolve();});});
  await main.ev('shotTestElectron.clipboard.write(shotOldClipboard);setTimeout(()=>shotTestElectron.BrowserWindow.getAllWindows().find(w=>!w.__snowCapture).close(),150);true');
  // Detach before shutdown: once the Node context is gone its inspector no longer answers evaluations.
  main.close();
  await exited;
  main = null;
  assert.equal(JSON.parse(fs.readFileSync(path.join(nextDir,'Снимки',ids[0],'meta.json'),'utf8')).ops.length,beforeClose+1);
  console.log(JSON.stringify({ result: 'PASS', app: appPath, scenarios: ['capture and editing', 'native clipboard', 'conflicts and dynamic shortcut labels', 'cancel restores main window', 'six themes in both windows', 'Recycle Bin deletion + undo + expiry', 'backup restore', 'statistics', 'guide opens', 'data migration', 'main closes editor and saves pending marks'], screenshots: out, profile }));
  process.exit(0);
})().catch(async e => { console.error(e.stack); if(main) await main.ev('if(global.shotCovers)shotCovers.forEach(w=>{if(!w.isDestroyed())w.destroy()});if(global.shotOldClipboard)shotTestElectron.clipboard.write(shotOldClipboard);true').catch(()=>{}); process.exit(1); });
