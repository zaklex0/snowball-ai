'use strict';
// Check conflicting edits and a failed deletion in two windows using only an isolated test profile.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Store } = require('../storage');
const { connect, freePort } = require('./guide-shots/cdp');

(async () => {
  const root = path.resolve(__dirname, '..');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-transcript-ui-'));
  const profile = path.join(tmp, 'profile'), data = path.join(tmp, 'data');
  await fs.mkdir(profile); await fs.mkdir(data);
  await fs.writeFile(path.join(profile, 'settings.json'), JSON.stringify({ dataDir: data }));
  await fs.writeFile(path.join(data, 'profile.json'), JSON.stringify({ name: 'Тест', welcomed: true }));
  const store = await new Store(data).init();
  await store.saveTranscript({ id: 'tr1', name: 'Тест.wav', text: 'Старый текст.', duration: 2, cues: [{ start: 0, end: 2, text: 'Старый текст.' }] });
  const [inspectPort, debugPort] = await Promise.all([freePort(), freePort()]);
  const child = spawn(require('electron'), ['.', '--inspect=' + inspectPort, '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile],
    { cwd: root, stdio: 'ignore', windowsHide: true });
  try {
    const main = await connect(inspectPort, (t) => t.type === 'node');
    assert.equal(path.resolve(await main.ev("process.mainModule.require('electron').app.getPath('userData')")), path.resolve(profile));
    const first = await connect(debugPort, (t) => /index\.html/.test(t.url));
    await first.until('!!window.vsApi && document.readyState === "complete"');
    await first.ev(`window.snowTestErrors=[]; window.addEventListener('error',e=>window.snowTestErrors.push(e.message)); window.addEventListener('unhandledrejection',e=>window.snowTestErrors.push(String(e.reason))); true`);
    const firstId = (await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json()).find((t) => /index\.html/.test(t.url)).id;
    await first.ev(`document.querySelector('[data-page="transcribe"]').click(); true`);
    await first.until(`!!document.querySelector('#tr-list .tr-open')`);
    await first.ev(`document.querySelector('#tr-list .tr-open').click(); true`);
    await first.until(`!!document.querySelector('.tr-text')`);
    await first.ev(`window.snowPlayer=document.querySelector('.tr-player'); true`);
    assert.equal((await first.ev(`vsApi.windowOpen([{kind:'transcribe'}])`)).ok, true);
    const second = await connect(debugPort, (t) => /index\.html/.test(t.url) && t.id !== firstId);
    await second.until('!!window.vsApi && document.readyState === "complete"');
    await first.ev(`(() => {const x=document.querySelector('.tr-text'); x.focus(); x.value='Моя правка.'; x.dispatchEvent(new Event('input',{bubbles:true})); return true;})()`);
    assert.equal((await second.ev(`vsApi.transcriptSave({id:'tr1',text:'Новее.',cues:[{start:0,end:2,text:'Новее.'}]})`)).ok, true);
    await first.ev(`document.querySelector('.tr-text').dispatchEvent(new Event('change',{bubbles:true})); true`);
    await first.until(`document.querySelector('#toast').textContent.includes('изменили или удалили')`);
    assert.equal(await first.ev(`document.querySelector('.tr-text').value`), 'Моя правка.');
    assert.equal(await first.ev(`document.querySelector('.tr-player')===window.snowPlayer`), true);
    await first.ev(`document.querySelector('.tr-text').blur(); true`);
    await first.ev(`document.querySelector('[data-page="transcribe"]').click(); true`);
    await first.until(`document.body.textContent.includes('Правка не сохранилась')`);
    assert.equal((await first.ev(`vsApi.transcriptGet('tr1')`)).transcript.text, 'Новее.');
    await main.ev(`process.mainModule.require('electron').shell.trashItem=async()=>{throw new Error('unavailable')}; true`);
    assert.equal((await second.ev(`vsApi.transcriptDelete('tr1')`)).ok, false);
    assert.equal((await second.ev(`vsApi.transcriptGet('tr1')`)).transcript.text, 'Новее.');
    await main.ev(`(() => {const fs=process.mainModule.require('fs').promises;process.mainModule.require('electron').shell.trashItem=async(file)=>{if(file!==${JSON.stringify(path.join(data, 'Транскрибации', 'tr1.json'))})throw Error('wrong path');await fs.unlink(file)};return true})()`);
    assert.equal((await second.ev(`vsApi.transcriptDelete('tr1')`)).ok, true);
    await first.ev(`document.querySelector('.tr-text').blur(); true`);
    await first.ev(`document.querySelector('[data-page="transcribe"]').click(); true`);
    try { await first.until(`document.body.textContent.includes('Расшифровку удалили в другом окне')`); }
    catch (e) {
      console.error('UI state:', await first.ev(`({ errors:Array.from(document.querySelectorAll('.tr-err')).map(x=>x.textContent), text:document.querySelector('.tr-text')?.value, active:document.activeElement?.outerHTML.slice(0,150), history:document.querySelector('#tr-list')?.textContent, current:Array.from(document.querySelectorAll('.nav-icon')).filter(x=>x.getAttribute('aria-current')).map(x=>x.outerHTML.slice(0,150)), main:document.querySelector('#tr-main')?.innerText.slice(0,1000), exceptions:window.snowTestErrors })`));
      throw e;
    }
    assert.equal(await first.ev(`document.querySelector('.tr-text').value`), 'Моя правка.');
    assert.equal(await first.ev(`Array.from(document.querySelectorAll('.tr-opts button')).find(b=>b.textContent.includes('Повторить сохранение')).disabled`), true);
    first.close(); second.close(); main.close();
    console.log('OK: conflicting edits and failed or remote deletion preserve the transcript and unsaved draft');
  } finally {
    child.kill();
    await new Promise((resolve) => child.exitCode !== null ? resolve() : child.once('exit', resolve));
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
