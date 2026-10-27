// Public guide: only generated shapes and example text, in the runner's isolated profile.
module.exports = async function ({ main, page, shot }) {
  const { ev, until, sleep } = page;
  const click = selector => ev(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await main.ev("process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].setContentSize(1280,820)");
  await until('!!window.vsApi && !!document.querySelector(".capture-nav")');
  await ev("vsApi.setTheme('light')");
  await ev("vsApi.saveProfile({name:'Гость'})");
  // Refresh this window's own state after the direct API save (sync is sent only to other windows).
  await page.send('Page.reload', {});
  await until("document.querySelector('#side-name')?.textContent === 'Гость'");
  await ev("document.querySelectorAll('dialog[open]').forEach(d=>d.close())");
  await click('.capture-nav');
  await until('!!window.screenshotEditor');
  await until("!!document.querySelector('.shot-key .capture-shortcut-change') && document.querySelector('.shot-key-state').textContent.length > 0");
  // Guide pictures always show the ordinary default. The installed Snowball may own Alt+Z;
  // change only the isolated guide window's displayed labels, never its actual registration.
  async function guideShot(name, targets) {
    await ev(`(() => {
      const nav = document.querySelector('.capture-nav');
      nav.querySelector('kbd').textContent = 'Alt + Z';
      nav.title = 'Снимки экрана · Alt + Z';
      document.querySelector('#capture-shortcut-notice').hidden = true;
      document.querySelector('.shot-key output').textContent = 'Alt + Z';
      document.querySelector('.shot-key-state').textContent = 'Alt + Z — работает поверх других окон, пока Snowball открыта';
      document.querySelector('.shot-empty-key').textContent = 'Нажмите «Снять область» или Alt + Z.';
      return true;
    })()`);
    await shot(name, targets);
  }
  await guideShot('01-where', { section: '.capture-nav', capture: '[data-action=capture]', key: '.shot-key', help: '[data-guide=screenshots]' });
  // Add two harmless fixtures via the real import handler.
  for (let i = 1; i <= 2; i++) {
    const png = await ev(`(() => { const c=document.createElement('canvas');c.width=640;c.height=280;const g=c.getContext('2d');g.fillStyle='#e0e9e1';g.fillRect(0,0,640,280);g.fillStyle='#fff9f4';g.fillRect(30,30,580,220);g.fillStyle='#416551';g.font='bold 28px sans-serif';g.fillText('План проекта — пример ${i}',55,80);g.font='18px sans-serif';g.fillText('Подготовить материалы',55,130);g.fillText('Обсудить идею',55,175);g.fillStyle='#f4aa84';g.fillRect(420,105,150,90);return c.toDataURL('image/png').split(',')[1] })()`);
    await main.ev(`(() => {const r=process.mainModule.require,e=r('electron'),f=r('path').join(e.app.getPath('userData'),'guide-${i}.png');r('fs').writeFileSync(f,Buffer.from(${JSON.stringify(png)},'base64'));e.dialog.showOpenDialog=async()=>({canceled:false,filePaths:[f]});return true})()`);
    const item = await ev('vsApi.captureImport()');
    await ev(`window.screenshotEditor.refresh().then(()=>window.screenshotEditor.open(${JSON.stringify(item.id)}))`);
  }
  async function draw(tool, x, y, dx, dy) {
    await click('[data-tool=' + tool + ']');
    const rect = await ev("(()=>{const r=document.querySelector('.shot-stage canvas').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()");
    const send = (type, px, py) => page.send('Input.dispatchMouseEvent', { type, x: rect.x + px * rect.w, y: rect.y + py * rect.h, button: 'left', buttons: type === 'mouseMoved' ? 1 : undefined, clickCount: 1 });
    await send('mousePressed', x, y); await send('mouseMoved', dx, dy); await send('mouseReleased', dx, dy);
  }
  await draw('marker', .08, .47, .59, .47);
  await ev('window.screenshotEditor.flush()');
  await guideShot('02-tools', { tools: '.shot-tools', pressure: '.shot-pressure-label', color: '.shot-color', undo: '.shot-undo' });
  await draw('text', .1, .73, .57, .93);
  await page.send('Input.insertText', { text: 'Проверить сегодня' });
  await guideShot('03-text', { text: '.shot-text', tool: '[data-tool=text]' });
  await ev('window.screenshotEditor.flush()');
  await draw('focus', .64, .35, .91, .73);
  await ev('window.screenshotEditor.flush()');
  await guideShot('04-focus', { tool: '[data-tool=focus]', blur: '.shot-blur-label', image: '.shot-stage canvas', copy: '[data-action=copy]' });
  const deletedId = await ev("document.querySelector('.shot-card:last-child').dataset.id");
  await click('.shot-card:last-child .shot-delete');
  await until(`!document.querySelector('.shot-card[data-id=${JSON.stringify(deletedId)}]') && !document.querySelector('.shot-toast').hidden && document.querySelectorAll('.shot-card').length === 1`);
  await guideShot('05-history', { history: '.shot-library', copy: '.shot-card .shot-copy', remove: '.shot-card .shot-delete', undo: '.shot-toast' });
  await click('.shot-toast button');
  await sleep(250);
  await draw('crop', .16, .12, .79, .82);
  await until("!document.querySelector('.shot-crop-actions').hidden");
  await guideShot('06-crop-selection', { tool: '[data-tool=crop]', selection: '.shot-stage canvas', apply: '[data-action=apply-crop]' });
  await click('[data-action=apply-crop]');
  await until("!document.querySelector('[data-action=reset-crop]').hidden");
  await ev('window.screenshotEditor.flush()');
  await sleep(500);
  await guideShot('07-crop-result', { image: '.shot-stage canvas', reset: '[data-action=reset-crop]', copy: '[data-action=copy]' });
  return shot.boxes;
};
