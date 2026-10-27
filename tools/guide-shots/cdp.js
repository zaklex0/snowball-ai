// Talking to the running test app over the DevTools protocol: main process (--inspect) and its window (--remote-debugging-port).
const fs = require('fs');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(port, pick) {
  let url = null;
  for (let i = 0; i < 80 && !url; i++) {
    try { const t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(pick); if (t) url = t.webSocketDebuggerUrl; } catch (e) { /* not up yet */ }
    if (!url) await sleep(500);
  }
  if (!url) throw new Error('Nothing to connect to on port ' + port);
  const ws = new WebSocket(url);
  let seq = 0;
  const wait = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } };
  await new Promise((r) => { ws.onopen = r; });
  const send = (method, params) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => wait.set(id, r)); };
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error(expr.slice(0, 100) + ' → ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const until = async (expr, ms) => { for (let i = 0; i < (ms || 20000) / 200; i++) { if (await ev(expr)) return true; await sleep(200); } throw new Error('Timed out: ' + expr); };
  return { send, ev, until, sleep, close: () => ws.close() };
}

// shot(name, targets): hides the notifications, photographs the window and measures the boxes of the targets.
// A target is a CSS selector or { sel, text } — the first element of sel whose text contains text.
function shotter(page, dir, format = 'png') {
  const all = {};
  const shot = async (name, targets) => {
    await page.ev(`(() => { const t = document.getElementById('toast'), u = document.getElementById('utoast'); if (t) t.classList.remove('show'); if (u) u.hidden = true; return 1; })()`);
    await sleep(400);
    const boxes = await page.ev(`(() => { const out = {}, t = ${JSON.stringify(targets)};
      for (const k in t) {
        const el = typeof t[k] === 'string' ? document.querySelector(t[k]) : Array.from(document.querySelectorAll(t[k].sel)).find((x) => x.innerText.includes(t[k].text));
        if (!el) { out[k] = null; continue; }
        const r = el.getBoundingClientRect(); out[k] = [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
      }
      return out; })()`);
    const missing = Object.keys(boxes).filter((k) => !boxes[k]);
    if (missing.length) throw new Error(name + ': not found ' + missing.join(', '));
    const r = await page.send('Page.captureScreenshot', { format, ...(format === 'webp' ? { quality: 82 } : {}) });
    fs.writeFileSync(path.join(dir, name + '.' + format), Buffer.from(r.result.data, 'base64'));
    all[name] = boxes;
    console.log('shot', name);
  };
  shot.boxes = all;
  return shot;
}

module.exports = { connect, shotter, sleep };
