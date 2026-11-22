'use strict';
// Runs the desktop app against a local Responses API with a temporary account and data folder.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { connect, freePort } = require('./guide-shots/cdp');

const root = path.resolve(__dirname, '..');
const partial = 'Этот фрагмент уже получен.';
const completed = 'Полный ответ.';

function toolCall(name, args) {
  return { type: 'function_call', id: 'fc_' + name, call_id: 'call_' + name, name, arguments: JSON.stringify(args), status: 'completed' };
}

function response(output = []) {
  return { id: 'resp_test', object: 'response', status: 'completed', output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
}

async function verify() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-assistant-undo-'));
  const profile = path.join(tmp, 'profile'), data = path.join(tmp, 'data');
  const event = { date: '2026-11-22', from: '15:00', title: 'Созвон', kind: 'call', note: '' };
  let eventId;
  const server = http.createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const user = Array.isArray(body.input) ? body.input.findLast(item => item.role === 'user')?.content : body.input;
      const afterTools = Array.isArray(body.input) && body.input.some(item => item.type === 'function_call_output');
      const calls = [];
      if (!afterTools && user === 'Измени календарь') {
        calls.push(toolCall('calendar_update', { ...event, id: eventId, from: '16:00' }));
        calls.push(toolCall('calendar_add', { ...event, title: 'Добавленный созвон' }));
      }
      if (!body.stream) {
        const result = response(calls.length ? calls : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: completed }] }]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (payload) => res.write('data: ' + JSON.stringify(payload) + '\n\n');
      if (user === 'Ответ без финала' || user === 'Обрыв соединения') {
        send({ type: 'response.output_text.delta', delta: partial });
        if (user === 'Обрыв соединения') setTimeout(() => res.destroy(), 120);
        else res.end('data: [DONE]\n\n');
        return;
      }
      if (user !== 'Пустой поток') {
        if (!calls.length) send({ type: 'response.output_text.delta', delta: completed });
        send({ type: 'response.completed', response: response(calls) });
      }
      res.end('data: [DONE]\n\n');
    } catch (error) { res.destroy(error); }
  });

  let child, main, page;
  try {
    await fs.mkdir(profile); await fs.mkdir(data);
    await fs.writeFile(path.join(profile, 'settings.json'), JSON.stringify({ dataDir: data, confirm: false, notify: false }));
    await fs.writeFile(path.join(data, 'profile.json'), JSON.stringify({ name: 'Тест', welcomed: true }));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const [inspect, debug] = await Promise.all([freePort(), freePort()]);
    const target = process.argv[2];
    const installed = target && /\.exe$/i.test(target);
    child = spawn(installed ? path.resolve(target) : require('electron'), [
      ...(installed ? [] : [target ? path.resolve(target) : root]),
      '--inspect=' + inspect, '--remote-debugging-port=' + debug, '--user-data-dir=' + profile
    ], { cwd: root, windowsHide: true, stdio: 'ignore', env: { ...process.env, OPENAI_BASE_URL: 'http://127.0.0.1:' + server.address().port + '/v1' } });
    main = await connect(inspect, t => t.type === 'node');
    page = await connect(debug, t => /index\.html/.test(t.url));
    await page.until('!!window.vsApi && document.readyState === "complete"');
    assert.equal(path.resolve(await main.ev("process.mainModule.require('electron').app.getPath('userData')")), path.resolve(profile));
    await page.ev("document.querySelector('[data-page=assistant]').click(); true");

    const sendChat = async (question) => {
      const text = JSON.stringify(question);
      await page.ev(`document.querySelector('#chat-input').value=${text}; document.querySelector('#chat-send').click(); true`);
      await page.until(`(async () => {
        const entry = (await vsApi.chatList()).chats[0];
        if (!entry) return false;
        const messages = (await vsApi.chatGet(entry.id)).chat.messages;
        return !document.querySelector('#chat-send').disabled && messages.at(-2)?.text === ${text} && messages.at(-1)?.role === 'assistant';
      })()`);
      return page.ev(`(async () => {
        const entry = (await vsApi.chatList()).chats[0];
        return (await vsApi.chatGet(entry.id)).chat.messages.at(-1);
      })()`);
    };
    const prompt = await sendChat('Создай промт для отмены');
    assert.equal(prompt.actions[0].status, 'done');
    const load = () => page.ev('vsApi.load()');
    const item = (await load()).prompts[0];
    assert.ok(item);
    const title = 'Моя свежая правка';
    assert.equal((await page.ev(`vsApi.savePrompt({ item: ${JSON.stringify({ ...item, title })} })`)).ok, true);
    const undo = await page.ev(`vsApi.assistantUndo(${JSON.stringify(prompt.actions[0].id)})`);
    assert.equal(undo.ok, false);
    assert.match(undo.error, /уже изменились/);
    assert.equal((await load()).prompts[0].title, title);

    assert.equal((await page.ev("vsApi.assistantCheckKey('openai', 'sk-local-snowball-test-key')")).ok, true);
    for (const question of ['Ответ без финала', 'Обрыв соединения']) {
      const message = await sendChat(question);
      assert.equal(message.text, partial);
      assert.equal(message.failed, true);
      assert.match(message.note, /оборвался/);
    }
    const empty = await sendChat('Пустой поток');
    assert.equal(empty.failed, true);
    assert.match(empty.note, /прервалась до начала/);
    const full = await sendChat('Обычный ответ');
    assert.equal(full.text, completed);
    assert.ok(!full.failed);

    eventId = (await page.ev(`vsApi.calSave(${JSON.stringify(event)})`)).id;
    const calendar = () => page.ev("vsApi.calAssistant('Измени календарь')");
    const undoCalendar = (id) => page.ev(`vsApi.calAssistantUndo(${JSON.stringify(id)})`);
    const initial = await calendar();
    assert.ok(initial.undoId, initial.reply);
    assert.equal((await load()).events.length, 2);
    assert.equal((await undoCalendar(initial.undoId)).ok, true);
    assert.equal((await load()).events[0].from, '15:00');
    assert.equal((await load()).events.length, 1);
    const later = await calendar();
    assert.ok(later.undoId, later.reply);
    assert.equal((await page.ev(`vsApi.calSave(${JSON.stringify({ ...event, id: eventId, from: '17:00' })})`)).ok, true);
    assert.match((await undoCalendar(later.undoId)).error, /уже изменились/);
    const events = (await load()).events;
    assert.equal(events.find(e => e.id === eventId).from, '17:00');
    assert.equal(events.length, 2);
    console.log('OK: incomplete and disconnected streams are saved as partial replies; undo preserves newer edits');
  } finally {
    page?.close(); main?.close();
    if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
    if (server.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}

verify().catch(error => { console.error(error); process.exitCode = 1; });
