'use strict';
// Measures UI responsiveness with generated prompts in an isolated profile.
const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { connect } = require('./guide-shots/cdp');

(async () => {
  const count = Math.max(1, Math.min(10000, Number(process.argv[2]) || 2000));
  const root = path.resolve(__dirname, '..');
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'snowball-library-timing-'));
  const profile = path.join(tmp, 'profile'), data = path.join(tmp, 'data');
  await fsp.mkdir(profile); await fsp.mkdir(data);
  await fsp.writeFile(path.join(profile, 'settings.json'), JSON.stringify({ dataDir: data }));
  await fsp.writeFile(path.join(data, 'profile.json'), JSON.stringify({ name: 'Тест', welcomed: true }));
  const prompts = Array.from({ length: count }, (_, i) => ({ id: 'p' + i, title: 'Промт ' + i,
    type: i % 2 ? 'Видео' : 'Статика', text: 'Пример промта для теста скорости. '.repeat(12), files: [] }));
  await fsp.writeFile(path.join(data, 'prompts.json'), JSON.stringify({ format: 'snowball', version: 1, prompts }));
  const child = spawn(require('electron'), ['.', '--inspect=9252', '--remote-debugging-port=9352', '--user-data-dir=' + profile],
    { cwd: root, stdio: 'ignore', windowsHide: true });
  try {
    const main = await connect(9252, (t) => t.type === 'node');
    assert.equal(path.resolve(await main.ev("process.mainModule.require('electron').app.getPath('userData')")), path.resolve(profile));
    const page = await connect(9352, (t) => /index\.html/.test(t.url));
    await page.until(`document.querySelectorAll('#rows tr[data-id]').length === ${Math.min(count, 100)}`, 60000);
    await page.ev(`document.querySelector('[data-page="prompts"]').click(); true`);
    await page.until(`document.querySelectorAll('#rows tr[data-id]').length === ${Math.min(count, 100)}`, 60000);
    if (count > 100) {
      await page.ev(`document.querySelector('.prompt-pages button:last-child').click(); true`);
      assert.ok((await page.ev(`document.querySelector('.prompt-pages-inner span').textContent`)).startsWith('101'));
      await page.ev(`document.querySelector('.prompt-pages button:first-child').click(); true`);
    }
    const result = await page.ev(`(async () => {
      const input = document.querySelector('#search');
      const measure = async (q) => { const start = performance.now(); input.value=q; input.dispatchEvent(new Event('input',{bubbles:true}));
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))); return Math.round(performance.now()-start); };
      return { clear: await measure('нет такого промта'), all: await measure(''), narrow: await measure('Промт 1'), allAgain: await measure('') };
    })()`);
    console.log(JSON.stringify({ count, milliseconds: result }));
    if (count > 100) {
      await page.ev(`document.querySelector('.edit-btn').click(); document.querySelector('#f-text').value='Несохранённый текст'; document.querySelector('.prompt-pages button:last-child').click(); true`);
      assert.equal(await page.ev(`document.querySelector('#f-text').value`), 'Несохранённый текст');
      assert.ok((await page.ev(`document.querySelector('.prompt-pages-inner span').textContent`)).startsWith('1–100'));
      assert.match(await page.ev(`document.querySelector('#toast').textContent`), /Сначала сохраните/);
      await page.ev(`document.querySelector('#cancel-btn').click(); true`);
      await page.send('Emulation.setDeviceMetricsOverride', { width: 750, height: 700, deviceScaleFactor: 1, mobile: false });
      await page.ev(`document.documentElement.setAttribute('data-theme','macos'); true`);
      for (const look of ['light', 'dark']) {
        await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: look }] });
        const positions = await page.ev(`Array.from(document.querySelectorAll('.prompt-pages button')).map(b=>({left:b.getBoundingClientRect().left,right:b.getBoundingClientRect().right}))`);
        assert.ok(positions.every(p => p.left >= 0 && p.right <= 750), JSON.stringify({ look, positions }));
      }
    }
    await page.ev(`document.querySelector('#search').value='Промт ${count - 1}'; document.querySelector('#search').dispatchEvent(new Event('input',{bubbles:true})); true`);
    assert.equal(await page.ev(`document.querySelectorAll('#rows tr[data-id]').length`), 1);
    assert.equal(await page.ev(`document.querySelector('#rows tr[data-id]').dataset.id`), 'p' + (count - 1));
    page.close(); main.close();
  } finally {
    child.kill();
    await new Promise((resolve) => child.exitCode !== null ? resolve() : child.once('exit', resolve));
    await fsp.rm(tmp, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
