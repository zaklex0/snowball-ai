// Public guide for «Скиллы»: only example skills written here and example data («Гость») in the runner's isolated profile.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeZip } = require('../../archive');

module.exports = async function ({ main, page, shot }) {
  const { ev, until, sleep } = page;
  const click = selector => ev(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const closeDialogs = () => ev("document.querySelectorAll('dialog[open]').forEach(d => d.close())");
  await main.ev("process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].setContentSize(1280,820)");
  await until('!!window.vsApi');
  await ev("vsApi.setTheme('light')");
  await ev("vsApi.saveProfile({name:'Гость'})");

  // Example skills, made up for the guide.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowball-guide-skills-'));
  const covers = path.join(dir, 'covers.md'), reels = path.join(dir, 'reels-script.md'), site = path.join(dir, 'landing-builder.zip');
  fs.writeFileSync(covers, '---\nname: Обложки роликов\n---\n\n# Обложки роликов\n\nСначала сюжет, потом свет, камера и детали.\n');
  fs.writeFileSync(reels, '---\nname: Сценарий рилса\n---\n\n# Сценарий рилса\n\nХук в первые 2 секунды, три сцены, призыв в конце.\n');
  await writeZip(site, [
    { name: 'landing-builder/SKILL.md', data: '---\nname: Сборщик лендингов\n---\n\n# Сборщик лендингов\n\nСобирает страницу из блоков.\n' },
    { name: 'landing-builder/blocks/hero.html', data: '<section>hero</section>' },
    { name: 'landing-builder/blocks/footer.html', data: '<footer>footer</footer>' }
  ]);
  const add = async (file, type, desc) => {
    await ev(`vsApi.skillInspect(${JSON.stringify(file)})`);
    const r = await ev(`vsApi.skillAdd({ path: ${JSON.stringify(file)}, title: '', type: '${type}', desc: ${JSON.stringify(desc)} })`);
    return r.skillId;
  };
  const key = await ev("vsApi.assistantCheckKey('openai', 'sk-test-guide-0000000000')");
  if (!key || !key.ok) throw new Error('fake key: ' + JSON.stringify(key));
  await add(site, 'code', 'Собирает одностраничный сайт из готовых блоков: шапка, преимущества, отзывы, подвал. Ассистент спрашивает, о чём страница, и подбирает блоки. Внутри архива — инструкция и шаблоны блоков.');
  const reelsId = await add(reels, 'video', '');
  await ev(`vsApi.skillDescribe('${reelsId}', true)`);
  const coversId = await add(covers, '', '');
  await ev(`vsApi.skillDescribe('${coversId}', false)`);

  // Refresh this window's own state after the direct API saves (sync is sent only to other windows).
  await ev("localStorage.setItem('libView', 'prompts')");
  await page.send('Page.reload', {});
  await until("document.querySelector('#side-name')?.textContent === 'Гость'");
  await closeDialogs();
  await click('[data-page="prompts"]');
  await sleep(500);
  // Step 1: the switch, then the list.
  await shot('01-where', { seg: '#lib-seg [data-lib="skills"]' });
  await click('#lib-seg [data-lib="skills"]');
  await sleep(500);
  await shot('01b-list', { add: '#skill-add-btn', type: '#sk-rows tr:first-child .chip', dl: '#sk-rows tr:first-child .btn-mini.dl', desc: '#sk-rows tr:first-child .sk-desc' });
  // Step 2: «Добавить скилл» with the file window replaced by a ready answer.
  await main.ev(`(() => { const { dialog } = process.mainModule.require('electron'); dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(covers)}] }); return 1; })()`);
  await click('#skill-add-btn');
  await until("!!document.querySelector('.sk-form')");
  await ev("document.activeElement && document.activeElement.blur()");
  await sleep(300);
  await shot('02-form', { title: '.sk-form input.input', types: '.sk-form .cat-picker', desc: '.sk-form textarea' });
  await ev("[...document.querySelectorAll('.sk-form button')].find(b => b.textContent.trim() === 'Отмена').click()");
  await sleep(300);
  // Step 3: the described skill (the newest one is on top).
  await ev("window.scrollTo(0, 0)");
  await shot('03-desc', { who: '#sk-rows tr:first-child .sk-who', edit: '#sk-rows tr:first-child .sk-acts .btn-mini:first-child', redo: '#sk-rows tr:first-child .sk-acts .btn-mini:last-child' });
  // Step 4: a skill in LLM — the stub answers (the key goes away for this frame).
  await ev("vsApi.assistantDeleteKey('openai')");
  await page.send('Page.reload', {});
  await until("document.querySelector('#side-name')?.textContent === 'Гость'");
  await closeDialogs();
  await click('[data-page="assistant"]');
  await sleep(600);
  const text = fs.readFileSync(reels, 'utf8');
  await ev(`(() => { const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(text)}], 'reels-script.md', { type: 'text/markdown' }));
    document.getElementById('view-assistant').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); return 1; })()`);
  await until("!!document.querySelector('.att-thumb.att-doc:not(.loading)')");
  await ev(`(() => { const i = document.getElementById('chat-input'); i.value = 'Закинь мне скилл туда, в хранилище'; i.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('chat-send').click(); return 1; })()`);
  await until("!!document.querySelector('.act-card .act-buttons button')", 30000);
  await ev("document.activeElement && document.activeElement.blur()");
  await sleep(500);
  await shot('04-llm', { file: '.msg-user .bubble-doc', card: '.act-card' });
  return shot.boxes;
};
