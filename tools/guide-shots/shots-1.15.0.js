// Scenario of the guide 1.15.0 «Транскрибация»: clicks through the section on the demo video and photographs it.
// Returns the boxes of the buttons on every screenshot (see cdp.shotter). Run through run.js.
module.exports = async function ({ main, page, shot, demo }) {
  const { ev, until, sleep } = page;
  const click = (sel) => ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
  const clickText = (sel, text) => ev(`Array.from(document.querySelectorAll(${JSON.stringify(sel)})).find((b) => b.innerText.includes(${JSON.stringify(text)})).click()`);
  const tab = (i) => ev(`document.querySelectorAll('.tr-tabs .tr-seg button')[${i}].click()`);

  await main.ev(`(() => { const r = process.mainModule.require, e = r('electron');
    e.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(demo)}] });
    e.BrowserWindow.getAllWindows()[0].setContentSize(1280, 820); return 1; })()`);
  await until('!!window.vsApi && !!document.querySelector(".nav-icon[data-page=transcribe]")');
  // A tidy profile: a key for the fake server, a nickname, two earlier transcriptions, two tabs.
  await ev(`vsApi.assistantCheckKey('openai', 'sk-test-guide-screenshots').then((r) => r && r.ok)`);
  await ev(`vsApi.saveProfile({ name: 'Гость' })`);
  const day = 864e5;
  await ev(`(async () => {
    const mk = (id, name, kind, dur, text, ago) => vsApi.transcriptSave({ id, name, kind, source: '', duration: dur, model: 'gpt-4o-mini-transcribe', text,
      cues: [{ start: 0, end: dur, text }], createdAt: Date.now() - ago });
    await mk('tguide1camera', 'урок 2 — движение камеры.m4a', 'audio', 755, 'Сегодня разбираем, как писать промты, чтобы камера двигалась так, как вы задумали.', ${day});
    await mk('tguide2reels', 'рилс — оживляем фото.mp4', 'video', 58, 'Старые фото оживают за минуту. Смотрите, как это делается в нейросети.', ${day * 1.2});
    return 1; })()`);
  await ev(`vsApi.setTabs({ list: [{ kind: 'home' }, { kind: 'transcribe' }], active: 0 })`);
  await page.send('Page.reload', {});
  await sleep(2500);
  await until('!!document.querySelector(".nav-icon[data-page=transcribe]")');
  await ev(`(() => { const d = document.getElementById('profile-dlg'); if (d && d.open) d.close(); return 1; })()`);

  // 1. Where it is: the icon, the «+» menu open, the tile on «Главная».
  await click('.nav-icon[data-page=home]');
  await sleep(300);
  await click('#tab-plus');
  await shot('01-where', { icon: '.nav-icon[data-page=transcribe]', menuItem: { sel: '#tab-menu button', text: 'Транскрибация' }, homeTile: { sel: '.home-tile', text: 'Транскрибация' } });
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })), document.body.click(), 1`);
  await click('.nav-icon[data-page=transcribe]');
  await sleep(400);
  // 2. The empty page.
  await shot('02-empty', { drop: '.tr-drop', pick: '.tr-drop .btn', hist: '.tr-hist', help: '.tr-help' });
  // 3. A file is picked.
  await click('.tr-drop .btn');
  await until('!!document.querySelector(".tr-file")');
  await shot('03-file', { model: '.tr-opts select', go: '.tr-opts .btn-primary', remove: '.tr-file-h .btn' });
  // 4. Working.
  await click('.tr-opts .btn-primary');
  await until('document.querySelector(".tr-prog .tr-soft") && /Нашёл кусков/.test(document.querySelector(".tr-prog .tr-soft").textContent)', 30000);
  await shot('04-busy', { bar: '.tr-prog', stop: '.tr-prog .btn', dot: '.tab .tab-busy' });
  await until('!!document.querySelector(".tr-res")', 90000);
  await sleep(800);
  // 5. The result: the player with a subtitle, the strip, the tabs.
  await ev(`(() => { document.querySelector('.tr-player video').currentTime = 11; return 1; })()`);
  await sleep(900);
  await shot('05-result', { sub: '.tr-sub', strip: '.tr-tl', tabs: '.tr-tabs .tr-seg' });
  // 6. The text and the buttons under it.
  await ev(`(() => { document.getElementById('scroller').scrollTop = 99999; return 1; })()`);
  await shot('06-text', { text: '.tr-text', srt: { sel: '.tr-acts .btn', text: 'Субтитры' }, prompt: { sel: '.tr-acts .btn', text: 'В промт' }, llm: { sel: '.tr-acts .btn', text: 'Спросить' } });
  // 7. «Тайминги».
  await tab(1);
  await sleep(300);
  await ev(`document.querySelectorAll('.tr-cue')[2].click()`);
  await sleep(500);
  await ev(`(() => { document.querySelector('.tr-tabs').scrollIntoView({ block: 'start' }); document.getElementById('scroller').scrollTop -= 40; return 1; })()`);
  await shot('07-cues', { fmt: '.tr-copyfmt .tr-seg', copy: '.tr-copyfmt .btn', cue: '.tr-cue.now' });
  // 8. «Кратко»: the button, then what it makes.
  await tab(2);
  await sleep(300);
  await shot('08-sum-empty', { make: '.tr-sum-empty .btn' });
  await click('.tr-sum-empty .btn');
  await until('!!document.querySelector(".tr-sum h4")', 20000);
  await shot('09-sum', { brief: '.tr-sum p', points: '.tr-sum ul', again: { sel: '.tr-sum .link-btn', text: 'заново' } });
  // 9. The history with a search.
  await ev(`(() => { document.getElementById('scroller').scrollTop = 0; const s = document.getElementById('tr-search'); s.value = 'камер'; s.dispatchEvent(new Event('input')); return 1; })()`);
  await shot('10-search', { search: '.tr-search', item: '.tr-item', del: '.tr-item .tr-del' });
  await ev(`(() => { const s = document.getElementById('tr-search'); s.value = ''; s.dispatchEvent(new Event('input')); return 1; })()`);
  return shot.boxes;
};
