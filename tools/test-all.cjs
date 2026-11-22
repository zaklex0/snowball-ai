'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

async function verify() {
  const fixtures = await fs.mkdtemp(path.join(os.tmpdir(), 'snowball-all-tests-'));
  const files = (await fs.readdir(__dirname)).sort();
  const root = path.resolve(__dirname, '..');
  const screenshotShortcut = 'screenshot-fallback.test.cjs';
  const unit = files.filter(file => file.endsWith('.test.cjs') && file !== screenshotShortcut);
  const apps = files.filter(file => file.endsWith('-smoke.cjs') && file !== 'packaged-stream-smoke.cjs');
  const checks = [
    ['Модульные проверки', ['--test', ...unit.map(file => path.join(__dirname, file))]],
    [screenshotShortcut, [path.join(__dirname, screenshotShortcut)]],
    ...apps.map(file => [file, [path.join(__dirname, file)]]),
    ['transcription-smoke.cjs (старый способ)', [path.join(__dirname, 'transcription-smoke.cjs'), '--fallback']]
  ];
  const failed = [];
  try {
    for (const [name, args] of checks) {
      console.log('\n' + name);
      const result = spawnSync(process.execPath, args, {
        cwd: root, stdio: 'inherit', windowsHide: true,
        env: { ...process.env, SNOWBALL_TEST_OUTPUT: fixtures }
      });
      if (result.error) console.error(result.error);
      if (result.status !== 0) failed.push(name);
    }
  } finally {
    await fs.rm(fixtures, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  console.log(`\nПройдено ${checks.length - failed.length} из ${checks.length} запусков.`);
  if (failed.length) {
    console.error('Ошибки: ' + failed.join(', '));
    process.exitCode = 1;
  }
}

verify().catch(error => { console.error(error); process.exitCode = 1; });
