// Synthetic account and transcription only; never sign into the real cloud from the guide runner.
module.exports = async function ({ main, page, shot }) {
  const { ev, until, sleep } = page;
  await main.ev("process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].setContentSize(1280,820)");
  await until('!!window.vsApi');
  await ev("vsApi.setTheme('light')"); await ev("vsApi.saveProfile({name:'Гость'})");
  await ev("document.querySelectorAll('dialog[open]').forEach(d=>d.close()); document.getElementById('menu-btn').click()");
  await until("!!document.querySelector('[data-action=settings]')");
  await ev("document.querySelector('[data-action=settings]').click(); document.querySelector('.sd-item[data-sec=cloud]').click()");
  await sleep(200);
  await shot('01-account', { nav: '.sd-item[data-sec=cloud]', form: '#cloud-form' });
  // Emit an example UI state in the isolated test process; no login or network write.
  await main.ev("process.mainModule.require('electron').BrowserWindow.getAllWindows().filter(w=>/index\\.html/.test(w.webContents.getURL())).forEach(w=>w.webContents.send('cloud-state', {email:'example@example.com', lastSync:Date.now(), conflicts:[]}))");
  await sleep(100);
  await shot('02-synced', { state: '#cloud-signed' });
  for (const theme of ['dark', 'macos']) {
    await ev(`vsApi.setTheme('${theme}')`); await sleep(100);
    if (theme === 'macos') for (const look of ['light', 'dark']) { await ev(`vsApi.setMacStyle({look:'${look}'})`); await sleep(80); if (!await ev("document.querySelector('.cloud-card').getBoundingClientRect().width > 200")) throw Error('Account layout failed'); }
  }
  await ev("vsApi.setTheme('light'); document.getElementById('settings-close').click()");
  const poster = await ev("(() => { const c=document.createElement('canvas');c.width=640;c.height=360;const x=c.getContext('2d');x.fillStyle='#9ebac9';x.fillRect(0,0,640,360);x.fillStyle='#344b5c';x.fillRect(0,240,640,120);return c.toDataURL('image/jpeg',0.7);})()");
  const saved = await ev(`vsApi.transcriptSave({id:'guideTranscript',name:'Учебная запись.mp4',kind:'video',size:400000000,duration:90,text:'Обсудили план на неделю. Сначала подготовим материалы, затем проверим результат.',cues:[{start:0,end:8,text:'Обсудили план на неделю.'},{start:8,end:20,text:'Сначала подготовим материалы, затем проверим результат.'}],poster:${JSON.stringify(poster)}})`);
  if (!saved?.ok) throw Error('Failed to save demo transcript: ' + JSON.stringify(saved));
  await page.send('Page.reload', {});
  await until("document.querySelector('#side-name')?.textContent === 'Гость'");
  await ev("document.querySelectorAll('dialog[open]').forEach(d=>d.close()); document.querySelector('[data-page=transcribe]').click()");
  await sleep(200);
  // Use visible text rather than depending on the row's structure.
  await until("!!Array.from(document.querySelectorAll('.tr-open')).find(b=>b.textContent.includes('Учебная запись'))");
  await ev("Array.from(document.querySelectorAll('.tr-open')).find(b=>b.textContent.includes('Учебная запись')).click()");
  await until("!!document.querySelector('.tr-cover')");
  if (!await ev("document.querySelector('.tr-player').hidden && !document.querySelector('.tr-gone').hidden")) throw Error('Remote transcript must show a cover instead of a broken player');
  await shot('03-transcript', { result: '.tr-text[aria-label="Текст расшифровки"]' });
  return shot.boxes;
};
