// Checks «Промты» → «Скиллы» without spending money: node tools/skills-smoke.cjs
// Starts the fake OpenAI (tools/guide-shots/fake-openai.js answers the skill description) and Snowball.ai from the sources
// in a separate temporary profile (real keys and data are never touched). Adds a .md and a .zip skill, lets the assistant
// describe them, edits and deletes, adds one through LLM (the stub, without keys) and photographs the page in three themes.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const cdp = require('./guide-shots/cdp');
const { writeZip } = require('../archive');

const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snowball-skills-'));
const profile = path.join(tmp, 'profile'), data = path.join(tmp, 'data'), src = path.join(tmp, 'src');
[profile, data, src].forEach((d) => fs.mkdirSync(d, { recursive: true }));
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ dataDir: data, theme: 'light' }));

const MD = '---\nname: Обложки роликов\ndescription: промты для обложек\n---\n\n# Обложки\n\nСначала сюжет, потом свет и камера.\n';
const md = path.join(src, 'covers.md');
fs.writeFileSync(md, MD);

const kids = [];
process.on('exit', () => kids.forEach((k) => { try { k.kill(); } catch (e) { /* gone */ } }));
(async () => {
  const zip = path.join(src, 'site-builder.zip');
  await writeZip(zip, [
    { name: 'site-builder/SKILL.md', data: '# Site builder\n\nBuilds landing pages.\n' },
    { name: 'site-builder/templates/page.html', data: '<!doctype html><title>x</title>' }
  ]);
  kids.push(spawn(process.execPath, [path.join(__dirname, 'guide-shots', 'fake-openai.js')], { stdio: 'ignore' }));
  const electron = require(path.join(root, 'node_modules', 'electron'));
  kids.push(spawn(electron, ['.', '--inspect=9232', '--remote-debugging-port=9335', '--user-data-dir=' + profile], {
    cwd: root, env: Object.assign({}, process.env, { OPENAI_BASE_URL: 'http://127.0.0.1:8765/v1' }), stdio: 'ignore' }));
  const main = await cdp.connect(9232, (t) => t.type === 'node');
  const ud = await main.ev(`process.mainModule.require('electron').app.getPath('userData')`);
  assert.equal(path.resolve(ud), path.resolve(profile), 'not the test profile');
  const page = await cdp.connect(9335, (t) => t.type === 'page' && /index\.html/.test(t.url));
  await page.until(`!!window.vsApi && document.readyState === 'complete'`);
  await page.ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Пропустить' && x.offsetParent); if (b) b.click(); return 1; })()`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
  const shot = cdp.shotter(page, tmp, 'png');

  // without keys: the stub offers to keep a skill attached in LLM
  await page.ev(`document.querySelector('[data-page="assistant"]').click()`);
  await page.sleep(600);
  await page.ev(`(() => { const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(MD)}], 'covers.md', { type: 'text/markdown' }));
    document.getElementById('view-assistant').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); return 1; })()`);
  await page.until(`!!document.querySelector('.att-thumb.att-doc:not(.loading)')`);
  await shot('01-llm-attached', {});
  await page.ev(`(() => { const i = document.getElementById('chat-input'); i.value = 'Закинь мне скилл туда, в хранилище'; i.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('chat-send').click(); return 1; })()`);
  await page.until(`!!document.querySelector('.act-card .act-buttons button')`, 30000);
  await shot('02-llm-card', {});
  await page.ev(`(() => { const b = [...document.querySelectorAll('.act-card button')].find((x) => x.textContent.trim() === 'Сохранить'); if (!b) throw new Error('no Сохранить'); b.click(); return 1; })()`);
  await page.until(`document.querySelectorAll('.act-card.settled').length > 0`);
  let list = (await page.ev(`vsApi.load()`)).skills;
  assert.equal(list.length, 1, 'the skill from LLM is kept');
  assert.equal(list[0].title, 'Обложки роликов', 'title from name:');
  await shot('03-llm-saved', {});

  // without keys a description cannot be written
  const nokey = await page.ev(`vsApi.skillDescribe('${list[0].id}', false)`);
  assert.ok(nokey.nokey, 'no key → nokey');

  // with the (fake) ChatGPT key
  const key = await page.ev(`vsApi.assistantCheckKey('openai', 'sk-test-skills-0000000000')`);
  assert.ok(key && key.ok, 'key: ' + JSON.stringify(key));
  const a = await page.ev(`vsApi.skillInspect(${JSON.stringify(zip)})`);
  assert.ok(a.ok && a.kind === 'zip' && a.files === 2, JSON.stringify(a));
  assert.equal(a.title, 'site-builder', 'title from the folder name');
  const added = await page.ev(`vsApi.skillAdd({ path: ${JSON.stringify(zip)}, title: 'Сборщик сайтов', type: 'code', desc: '' })`);
  assert.ok(added.ok, JSON.stringify(added));
  const d1 = await page.ev(`vsApi.skillDescribe('${added.skillId}', true)`);
  assert.ok(d1.ok && d1.cost > 0, JSON.stringify(d1).slice(0, 300));
  const zipSkill = d1.skills.find((s) => s.id === added.skillId);
  assert.equal(zipSkill.type, 'code', 'the chosen type stays');
  assert.equal(zipSkill.descBy, 'gpt-6.1-sol');
  const d2 = await page.ev(`vsApi.skillDescribe('${list[0].id}', false)`);
  assert.equal(d2.skills.find((s) => s.id === list[0].id).type, 'static', 'the model sets the type');
  await page.ev(`vsApi.skillSave({ id: '${added.skillId}', desc: 'Своё описание.' })`);
  list = (await page.ev(`vsApi.load()`)).skills;
  assert.equal(list.find((s) => s.id === added.skillId).descBy, 'manual');
  const r = await page.ev(`vsApi.skillInspect('C:/Windows/win.ini')`);
  assert.ok(!r.ok, 'only .md and .zip');
  const bad = await page.ev(`vsApi.skillAdd({ path: 'C:/Windows/notes.md', title: 'x', type: '', desc: '' })`);
  assert.ok(!bad.ok, 'only picked files');

  // the page in three themes. The calls above went past the window, so it reloads to get the data and the theme.
  const reload = async () => {
    await page.send('Page.reload', { ignoreCache: true });
    await page.sleep(600);
    await page.until(`!!window.vsApi && document.readyState === 'complete' && !!document.querySelector('#lib-seg')`);
    await page.sleep(900);
  };
  for (const t of ['light', 'dark', 'macos']) {
    await page.ev(`vsApi.setTheme('${t}')`);
    await reload();
    await page.ev(`document.querySelector('[data-page="prompts"]').click()`);
    await page.sleep(400);
    await page.ev(`document.querySelector('#lib-seg [data-lib="skills"]').click()`);
    await page.sleep(400);
    assert.ok(await page.ev(`document.getElementById('skills-view').offsetParent !== null`), 'skills shown');
    assert.ok(await page.ev(`document.getElementById('prompts-card').offsetParent === null`), 'prompts hidden');
    assert.equal(await page.ev(`document.querySelectorAll('#sk-rows > tr').length`), 2, 'two skills on the page');
    await shot('04-skills-' + t, { seg: '#lib-seg', rows: '#sk-rows' });
  }
  await page.ev(`vsApi.setTheme('light')`);
  await reload();
  // «Добавить скилл»: the file window is replaced by a ready answer
  await main.ev(`(() => { const { dialog } = process.mainModule.require('electron'); dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(md)}] }); return 1; })()`);
  await page.ev(`document.getElementById('skill-add-btn').click()`);
  await page.sleep(400);
  await shot('05-add-form', {});
  await page.ev(`(() => { const dt = new DataTransfer(); dt.items.add(new File(['x'], 'x.md')); document.getElementById('view-prompts').dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true })); return 1; })()`);
  await page.sleep(200);
  await shot('06-drop-over', {});

  await page.ev(`vsApi.skillDelete('${added.skillId}')`);
  list = (await page.ev(`vsApi.load()`)).skills;
  assert.equal(list.length, 1, 'deleted');
  assert.ok(fs.existsSync(path.join(data, 'skills.json')));
  console.log('OK — снимки в', tmp);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
