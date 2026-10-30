// Checks a real LLM tool round-trip without spending money: list → read → propose category → confirm.
// Electron uses an isolated profile; a local fake Responses API supplies only test answers.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const cdp = require('./guide-shots/cdp');
const { writeZip } = require('../archive');

const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snowball-skill-type-'));
const profile = path.join(tmp, 'profile'), data = path.join(tmp, 'data');
fs.mkdirSync(profile, { recursive: true });
fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ dataDir: data, theme: 'light' }));
const kids = [];
let server;
process.on('exit', () => { kids.forEach((k) => { try { k.kill(); } catch (e) {} }); if (server) server.close(); });

function fakeResponse(item, stage, res) {
  const response = { id: 'resp_' + stage, object: 'response', status: 'completed', output: item ? [item] : [],
    usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 20, total_tokens: 120 } };
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
  if (!item) res.write('data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: 'Категория подходит для музыки и песен.' }) + '\n\n');
  res.end('data: ' + JSON.stringify({ type: 'response.completed', response }) + '\n\ndata: [DONE]\n\n');
}
function toolCall(name, args, stage) {
  return { type: 'function_call', id: 'fc_' + stage, call_id: 'call_' + stage, name, arguments: JSON.stringify(args), status: 'completed' };
}

(async () => {
  const seen = [];
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'check', object: 'response', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1 } }));
        return;
      }
      const outputs = (Array.isArray(body.input) ? body.input : []).filter((x) => x.type === 'function_call_output');
      const stage = outputs.length;
      if (stage === 0) { seen.push('skills_list'); fakeResponse(toolCall('skills_list', {}, 1), 1, res); return; }
      if (stage === 1) {
        const list = JSON.parse(outputs[0].output);
        assert.equal(list.length, 1);
        assert.equal(list[0].title, 'Suno Prompter');
        seen.push('skill_read');
        fakeResponse(toolCall('skill_read', { id: list[0].id }, 2), 2, res);
        return;
      }
      if (stage === 2) {
        const skill = JSON.parse(outputs[1].output);
        assert.match(skill.text, /музыкальные запросы и тексты песен/);
        assert.equal(skill.type, 'code');
        seen.push('skill_set_type');
        fakeResponse(toolCall('skill_set_type', { id: skill.id, revision: skill.revision, type: 'audio', reason: 'Скилл составляет музыкальные запросы и тексты песен для Suno.' }, 3), 3, res);
        return;
      }
      if (stage === 3) {
        assert.match(outputs[2].output, /карточка|Сделано/);
        fakeResponse(null, 4, res);
        return;
      }
      res.writeHead(500); res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const file = path.join(tmp, 'suno.skill');
  await writeZip(file, [{ name: 'suno/SKILL.md', data: '---\nname: Suno Prompter\n---\n\n# Suno Prompter\n\nПомогает создавать музыкальные запросы и тексты песен для Suno.\n' }]);
  const electron = require(path.join(root, 'node_modules', 'electron'));
  kids.push(spawn(electron, ['.', '--inspect=9233', '--remote-debugging-port=9336', '--user-data-dir=' + profile], {
    cwd: root, env: Object.assign({}, process.env, { OPENAI_BASE_URL: 'http://127.0.0.1:' + port + '/v1' }), stdio: 'ignore' }));
  const main = await cdp.connect(9233, (t) => t.type === 'node');
  assert.equal(path.resolve(await main.ev("process.mainModule.require('electron').app.getPath('userData')")), path.resolve(profile));
  const page = await cdp.connect(9336, (t) => t.type === 'page' && /index\.html/.test(t.url));
  await page.until("!!window.vsApi && document.readyState === 'complete'");
  await page.ev("(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Пропустить' && x.offsetParent); if (b) b.click(); return 1; })()");
  const inspected = await page.ev(`vsApi.skillInspect(${JSON.stringify(file)})`);
  assert.ok(inspected.ok);
  const added = await page.ev(`vsApi.skillAdd({ path: ${JSON.stringify(file)}, title: 'Suno Prompter', type: 'code', desc: 'Создаёт музыкальные запросы и тексты песен.' })`);
  assert.ok(added.ok);
  const key = await page.ev("vsApi.assistantCheckKey('openai', 'sk-test-skill-type-0000000000')");
  assert.ok(key.ok);
  await page.send('Page.reload', {});
  await page.until("!!window.vsApi && document.readyState === 'complete'");
  await page.ev("document.querySelector('[data-page=assistant]').click()");
  await page.ev("(() => { const input = document.getElementById('chat-input'); input.value = 'Перепроверь, пожалуйста, правильно ли стоит категория у Suno Prompter'; input.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('chat-send').click(); return 1; })()");
  await page.until("!!document.querySelector('.act-card .act-buttons button')", 30000);
  assert.deepEqual(seen, ['skills_list', 'skill_read', 'skill_set_type']);
  const card = await page.ev("document.querySelector('.act-card').textContent");
  assert.match(card, /Было: Code/);
  assert.match(card, /Станет: Аудио/);
  assert.equal((await page.ev('vsApi.load()')).skills.find((s) => s.id === added.skillId).type, 'code', 'waits for confirmation');
  await page.ev("document.querySelector('.act-card .act-buttons button').click()");
  await page.until("document.querySelector('.act-card').textContent.includes('Категория скилла изменена')", 10000);
  assert.equal((await page.ev('vsApi.load()')).skills.find((s) => s.id === added.skillId).type, 'audio');
  const reset = await page.ev(`vsApi.skillSave({ id: '${added.skillId}', type: 'code' })`);
  assert.ok(reset.ok);
  const confirmOff = await page.ev('vsApi.setConfirm(false)');
  assert.ok(confirmOff.ok);
  await page.send('Page.reload', {});
  await page.until("!!window.vsApi && document.readyState === 'complete'");
  await page.ev("document.querySelector('[data-page=assistant]').click()");
  await page.ev("document.getElementById('chat-new').click()");
  seen.length = 0;
  await page.ev("(() => { const input = document.getElementById('chat-input'); input.value = 'Перепроверь категорию Suno Prompter ещё раз'; input.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('chat-send').click(); return 1; })()");
  await page.until("!!document.querySelector('.act-card .act-done')", 30000);
  assert.deepEqual(seen, ['skills_list', 'skill_read', 'skill_set_type']);
  assert.equal((await page.ev('vsApi.load()')).skills.find((s) => s.id === added.skillId).type, 'audio', 'auto mode changes the type');
  await page.ev("[...document.querySelectorAll('.act-card .act-done button')].find(b => b.textContent === 'Отменить').click()");
  await page.until("document.querySelector('.act-card').textContent.includes('всё вернул как было')", 10000);
  assert.equal((await page.ev('vsApi.load()')).skills.find((s) => s.id === added.skillId).type, 'code', 'undo restores the prior type');
  console.log('OK — assistant read Suno Prompter, changed Code → Аудио with confirmation and auto mode, then undid it');
  server.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
