// Takes the screenshots of a guide «Как пользоваться» automatically: node tools/guide-shots/run.js 1.15.0
// 1. Starts the fake OpenAI (fake-openai.js) and Snowball.ai from the sources in a separate test profile in the temp folder
//    (its own settings and data folder; the real %APPDATA%\Snowball.ai, keys and data are never touched).
// 2. Runs the scenario shots-<version>.js: it clicks through the program and photographs it, and for every frame
//    remembers where the buttons are.
// 3. Saves the pictures as WebP into src/guides/<version>/ and the boxes of the buttons into src/guides/<version>/boxes.js.
// Still images are encoded by Chromium. Audio/video guides also need make-demo.ps1 run once.
const { spawn } = require('child_process');
const { once } = require('node:events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cdp = require('./cdp');

const version = process.argv[2];
if (!version) { console.error('Usage: node tools/guide-shots/run.js <version>'); process.exit(1); }
const root = path.resolve(__dirname, '..', '..');
const scenario = require('./shots-' + version + '.js');
const out = path.join(root, 'src', 'guides', version);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snowball-guide-'));
const profile = path.join(tmp, 'profile');
const data = path.join(tmp, 'data');
const raw = path.join(tmp, 'png');
[profile, data, raw, out].forEach((d) => fs.mkdirSync(d, { recursive: true }));
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ dataDir: data }));

const kids = [];
function stopAll() { kids.forEach((k) => { try { k.kill(); } catch (e) { /* already gone */ } }); }
process.on('exit', stopAll);

(async () => {
  const fake = spawn(process.execPath, [path.join(__dirname, 'fake-openai.js')], {
    env: { ...process.env, FAKE_DELAY: '1800', SNOWBALL_FAKE_OPENAI_PORT: '0' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true
  });
  kids.push(fake);
  const [apiPort] = await once(fake, 'message', { signal: AbortSignal.timeout(10000) });
  const [inspectPort, debugPort] = await Promise.all([cdp.freePort(), cdp.freePort()]);
  const electron = require(path.join(root, 'node_modules', 'electron'));
  kids.push(spawn(electron, ['.', '--inspect=' + inspectPort, '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile], {
    cwd: root, env: { ...process.env, OPENAI_BASE_URL: 'http://127.0.0.1:' + apiPort + '/v1' }, stdio: 'ignore', windowsHide: true
  }));
  const main = await cdp.connect(inspectPort, (t) => t.type === 'node');
  const ud = await main.ev(`process.mainModule.require('electron').app.getPath('userData')`);
  if (path.resolve(ud) !== path.resolve(profile)) throw new Error('Not the test profile: ' + ud);
  const page = await cdp.connect(debugPort, (t) => t.type === 'page' && /index\.html/.test(t.url));
  const boxes = await scenario({ main, page, shot: cdp.shotter(page, raw, 'webp'), demo: path.join(__dirname, 'demo', 'урок — озвучка.mp4') });
  for (const name of Object.keys(boxes)) {
    // Chromium produces WebP directly; no external converter is needed for still screenshots.
    fs.copyFileSync(path.join(raw, name + '.webp'), path.join(out, name + '.webp'));
  }
  fs.writeFileSync(path.join(out, 'boxes.js'), '// Made by tools/guide-shots/run.js: where the buttons are on each screenshot of this guide (pixels of 1280 × 820).\n' +
    'window.GUIDE_BOXES = window.GUIDE_BOXES || {};\nwindow.GUIDE_BOXES[' + JSON.stringify(version) + '] = ' + JSON.stringify(boxes) + ';\n');
  console.log('Saved ' + Object.keys(boxes).length + ' screenshots to ' + out);
  stopAll();
  process.exit(0);
})().catch((e) => { console.error(e); stopAll(); process.exit(1); });
