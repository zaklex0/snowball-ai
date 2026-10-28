// Checks the call summaries in the calendar without spending money: node tools/recap-smoke.cjs
// Starts a fake OpenAI (answers the summary request with a ready JSON) and Snowball.ai from the sources in a separate
// temporary profile (real keys and data are never touched), loads a summary text into an event and photographs the result.
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const assert = require('assert');
const cdp = require('./guide-shots/cdp');

const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snowball-recap-'));
const profile = path.join(tmp, 'profile'), data = path.join(tmp, 'data');
[profile, data].forEach((d) => fs.mkdirSync(d, { recursive: true }));
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ dataDir: data }));

const RECAP = {
  title: 'Правки монтажа', who: 'Дима', brief: 'Обсудили вторую версию ролика. Диме нравится темп, но вступление затянуто.',
  decisions: ['Сократить вступление', 'Заменить музыку в финале'],
  steps: [{ t: 'Прислать новую версию ролика', who: 'Я', mine: true, due: '' }, { t: 'Дать правки по звуку', who: 'Дима', mine: false, due: '' }],
  meets: [{ t: 'Созвон по новой версии', date: '', from: '', to: '' }]
};
const today = new Date(); const pad = (n) => String(n).padStart(2, '0');
RECAP.meets[0].date = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate() + 1 > 28 ? 28 : today.getDate() + 1)}`;
RECAP.meets[0].from = '17:00'; RECAP.meets[0].to = '17:30';
const seen = [];
const fake = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    seen.push(req.url + ' ' + Buffer.concat(chunks).toString('utf8').slice(0, 20000));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'r1', object: 'response', status: 'completed', output: [{ type: 'message', id: 'm1', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: JSON.stringify(RECAP), annotations: [] }] }],
      usage: { input_tokens: 900, input_tokens_details: { cached_tokens: 0 }, output_tokens: 300, total_tokens: 1200 } }));
  });
}).listen(8766, '127.0.0.1');

const kids = [];
const stop = () => { kids.forEach((k) => { try { k.kill(); } catch (e) { /* gone */ } }); fake.close(); };
process.on('exit', stop);
(async () => {
  const electron = require(path.join(root, 'node_modules', 'electron'));
  kids.push(spawn(electron, ['.', '--inspect=9231', '--remote-debugging-port=9334', '--user-data-dir=' + profile], {
    cwd: root, env: Object.assign({}, process.env, { OPENAI_BASE_URL: 'http://127.0.0.1:8766/v1' }), stdio: 'ignore' }));
  const main = await cdp.connect(9231, (t) => t.type === 'node');
  const ud = await main.ev(`process.mainModule.require('electron').app.getPath('userData')`);
  assert.equal(path.resolve(ud), path.resolve(profile), 'not the test profile');
  const page = await cdp.connect(9334, (t) => t.type === 'page' && /index\.html/.test(t.url));
  await page.until(`!!window.vsApi && document.readyState === 'complete'`);
  const key = await page.ev(`vsApi.assistantCheckKey('openai', 'sk-test-recap-0000000000')`);
  assert.ok(key && key.ok, 'key: ' + JSON.stringify(key));
  const d = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const saved = await page.ev(`vsApi.calSave({ date: '${d}', from: '09:00', to: '10:00', who: 'Дима', title: 'Правки монтажа', kind: 'call', remind: 0, note: '' })`);
  const bare = await page.ev(`vsApi.calSave({ date: '${d}', from: '14:00', to: '15:00', who: 'Оля', title: 'Новый созвон', kind: 'call', remind: 0, note: '' })`);
  const made = await page.ev(`vsApi.recapMake({ eventId: '${saved.id}', text: '10:02 Дима: вступление затянуто.\\n10:05 Я: пришлю новую версию завтра.', name: 'тест.txt' })`);
  assert.ok(made.ok, JSON.stringify(made));
  const ev = made.events.find((e) => e.id === saved.id);
  assert.equal(ev.recap.steps.length, 2);
  assert.equal(ev.recap.text, '', 'the window gets no long text');
  const text = await page.ev(`vsApi.recapText('${saved.id}')`);
  assert.ok(text.text.includes('вступление затянуто'));
  // an ordinary save keeps the summary
  await page.ev(`vsApi.calSave({ id: '${saved.id}', date: '${d}', from: '09:00', to: '10:30', who: 'Дима', title: 'Правки монтажа', kind: 'call', remind: 0, note: '' })`);
  const again = await page.ev(`vsApi.recapText('${saved.id}')`);
  assert.ok(again.text.length > 10, 'summary lost after an ordinary save');
  assert.ok(seen.some((s) => s.includes('"recap"')), 'the request had the schema');
  // the window: calendar, opened event, tabs
  await page.ev(`document.querySelector('[data-page="calendar"]').click()`);
  await page.sleep(600);
  await page.ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Пропустить' && x.offsetParent); if (b) b.click(); return 1; })()`);
  await page.sleep(500);
  await page.until(`!!document.querySelector('.cal-ev .flag')`);
  const shot = cdp.shotter(page, tmp, 'png');
  await shot('01-calendar', {});
  await page.ev(`(() => { const b = document.querySelector('.cal-ev .flag'); if (!b) throw new Error('no flag'); b.closest('.cal-ev').click(); return 1; })()`);
  await page.sleep(500);
  assert.ok(await page.ev(`!document.getElementById('cal-form').hidden`), 'the usual form opens first');
  await shot('02-form', {});
  await page.ev(`document.getElementById('cal-tab-sum').click()`);
  await page.sleep(400);
  await shot('02-summary', {});
  await page.ev(`[...document.querySelectorAll('#cal-recap button')].find((b) => b.textContent.includes('Добавить на доску')).click()`);
  await page.sleep(800);
  const tasks = await page.ev(`vsApi.load().then((r) => r.tasks.map((t) => t.title + '|' + t.due + '|' + t.tags))`);
  console.log('tasks', JSON.stringify(tasks));
  await shot('03-after-add', {});
  assert.equal(await page.ev(`[...document.querySelectorAll('#cal-tabs button:not([hidden])')].map((b) => b.textContent.trim()).join('|')`), 'Дело|Итоги•'.replace('•', '') + '|Расшифровка', 'three tabs, the form first');
  await page.ev(`document.getElementById('cal-tab-tr').click()`);
  await page.sleep(300);
  await page.ev(`(() => { const i = document.querySelector('#cal-recap .rc-search input'); i.value = 'вступление'; i.dispatchEvent(new Event('input')); return 1; })()`);
  assert.ok(await page.ev(`!!document.querySelector('#cal-recap .rc-line mark')`), 'search marks the text on the same tab');
  await shot('04-text', {});
  // an event without a summary: the box for the text is right in «Итоги»
  await page.ev(`document.querySelectorAll('dialog[open]').forEach((d) => d.close())`);
  await page.ev(`[...document.querySelectorAll('.cal-ev')].find((x) => x.textContent.includes('Новый созвон')).click()`);
  await page.sleep(500);
  await page.ev(`document.getElementById('cal-tab-sum').click()`);
  await page.sleep(300);
  await shot('05-empty', {});
  await page.ev(`(() => { const t = document.querySelector('#cal-recap textarea'); t.value = 'Решили сократить вступление.'; t.dispatchEvent(new Event('input')); return 1; })()`);
  await page.ev(`[...document.querySelectorAll('#cal-recap button')].find((x) => x.textContent.includes('Разобрать итоги')).click()`);
  await page.until(`!!document.querySelector('#cal-recap .rc-step')`);
  const saved2 = await page.ev(`vsApi.recapText('${bare.id}')`);
  assert.ok(saved2.text.includes('сократить вступление'), 'summary saved on the event');
  await shot('06-made', {});
  console.log('OK, pictures in', tmp);
  stop();
  process.exit(0);
})().catch((e) => { console.error(e); stop(); process.exit(1); });
