'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
app.whenReady().then(async () => {
  const root = path.resolve(__dirname, '..');
  const w = new BrowserWindow({ width: 1250, height: 930, show: false, webPreferences: { partition: 'stamps-' + Date.now(), contextIsolation: true } });
  await w.loadFile(path.join(root, 'mockups/task-number-alignment.html'));
  await w.webContents.executeJavaScript('document.fonts.ready.then(()=>true)');
  // Validate the exact painter shipped in the app, not a separate approximation.
  await w.webContents.executeJavaScript(await fs.readFile(path.join(root, 'src/task-number-stamp.js'), 'utf8'));
  await new Promise(r => setTimeout(r, 300));
  const results = await w.webContents.executeJavaScript(`(()=>{document.querySelector('#guides').checked=false;render();return Array.from(document.querySelectorAll('.samples > .circle'),b=>{const c=b.querySelector('canvas'),g=c.getContext('2d'),d=g.getImageData(0,0,c.width,c.height).data;let x0=c.width,y0=c.height,x1=-1,y1=-1;for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){const i=(y*c.width+x)*4;if(d[i+3]&&Math.abs(d[i]-81)<3&&Math.abs(d[i+1]-111)<3&&Math.abs(d[i+2]-149)<3){x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y)}}return {number:b.dataset.stampedNumber,centre:[(x0+x1+1)/2,(y0+y1+1)/2],canvas:[c.width/2,c.height/2],bounds:[x0,y0,x1,y1]}})})()`);
  assert.equal(results.length, 15);
  for (const r of results) {
    assert.ok(r.bounds[2] >= 0, 'Rendered glyph not found: ' + r.number);
    assert.ok(Math.abs(r.centre[0] - r.canvas[0]) <= 1, 'Horizontal centre: ' + JSON.stringify(r));
    assert.ok(Math.abs(r.centre[1] - r.canvas[1]) <= 1, 'Vertical centre: ' + JSON.stringify(r));
  }
  await w.webContents.executeJavaScript('document.querySelector("#guides").checked=true;render();true');
  await new Promise(r => setTimeout(r, 400));
  await fs.writeFile(path.join(root, 'mockups/task-number-alignment.png'), (await w.webContents.capturePage({ stayHidden: true, stayAwake: true })).toPNG());
  console.log('PASS: actual rendered pixel centres for 0–12, 20 and 100; all within 1/8 screen pixel of the circle centre.');
  console.log(JSON.stringify(results.map(r=>({number:r.number,centre:r.centre,canvas:r.canvas}))));
  app.quit();
}).catch(e => { console.error(e); app.exit(1); });
