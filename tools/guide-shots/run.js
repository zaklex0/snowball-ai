// Takes the screenshots of a guide «Как пользоваться» automatically: node tools/guide-shots/run.js 1.15.0
// 1. Starts the fake OpenAI (fake-openai.js) and Snowball.ai from the sources in a separate test profile in the temp folder
//    (its own settings and data folder; the real %APPDATA%\Snowball.ai, keys and data are never touched).
// 2. Runs the scenario shots-<version>.js: it clicks through the program and photographs it, and for every frame
//    remembers where the buttons are.
// 3. Saves the pictures as WebP into src/guides/<version>/ and the boxes of the buttons into src/guides/<version>/boxes.js.
// Needs ffmpeg in PATH (for WebP) and, for the demo video, make-demo.ps1 run once (it makes demo/урок — озвучка.mp4).
const { spawn, spawnSync } = require('child_process');
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
  kids.push(spawn(process.execPath, [path.join(__dirname, 'fake-openai.js')], { env: Object.assign({}, process.env, { FAKE_DELAY: '1800' }), stdio: 'inherit' }));
  const electron = require(path.join(root, 'node_modules', 'electron'));
  kids.push(spawn(electron, ['.', '--inspect=9229', '--remote-debugging-port=9333', '--user-data-dir=' + profile], {
    cwd: root, env: Object.assign({}, process.env, { OPENAI_BASE_URL: 'http://127.0.0.1:8765/v1' }), stdio: 'ignore'
  }));
  const main = await cdp.connect(9229, (t) => t.type === 'node');
  const ud = await main.ev(`process.mainModule.require('electron').app.getPath('userData')`);
  if (path.resolve(ud) !== path.resolve(profile)) throw new Error('Not the test profile: ' + ud);
  const page = await cdp.connect(9333, (t) => t.type === 'page' && /index\.html/.test(t.url));
  const boxes = await scenario({ main, page, shot: cdp.shotter(page, raw), demo: path.join(__dirname, 'demo', 'урок — озвучка.mp4') });
  for (const name of Object.keys(boxes)) {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(raw, name + '.png'), '-c:v', 'libwebp', '-quality', '82', path.join(out, name + '.webp')]);
    if (r.status !== 0) throw new Error('ffmpeg failed for ' + name);
  }
  fs.writeFileSync(path.join(out, 'boxes.js'), '// Made by tools/guide-shots/run.js: where the buttons are on each screenshot of this guide (pixels of 1280 × 820).\n' +
    'window.GUIDE_BOXES = window.GUIDE_BOXES || {};\nwindow.GUIDE_BOXES[' + JSON.stringify(version) + '] = ' + JSON.stringify(boxes) + ';\n');
  console.log('Saved ' + Object.keys(boxes).length + ' screenshots to ' + out);
  stopAll();
  process.exit(0);
})().catch((e) => { console.error(e); stopAll(); process.exit(1); });
