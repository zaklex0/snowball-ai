// Public guide for the macOS theme: only example data («Гость», example prompts, events and tasks) in the runner's isolated profile.
// The pictures show the painted background instead of the real glass: the desktop behind the window must not get into them.
module.exports = async function ({ main, page, shot }) {
  const { ev, until, sleep } = page;
  const click = selector => ev(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const closeDialogs = () => ev("document.querySelectorAll('dialog[open]').forEach(d => d.close())");
  // Only when the class is there: removing an absent class still rewrites the attribute and would wake the observer forever.
  const noGlass = () => ev("(() => { const r = document.documentElement, off = () => { if (r.classList.contains('glass')) r.classList.remove('glass'); }; off(); new MutationObserver(off).observe(r, { attributes: true, attributeFilter: ['class'] }); return 1; })()");
  const menuOpen = () => ev("document.getElementById('menu').hidden");
  const openTheme = async (third) => {
    if (await menuOpen()) await click('#menu-btn');
    await click('.has-sub[data-sub="theme"]');
    if (third) await ev("(() => { const w = document.querySelector('.has-sub[data-sub=macos]').closest('.sub-wrap'); w.dispatchEvent(new MouseEvent('mouseenter')); return 1; })()");
    await ev("document.activeElement && document.activeElement.blur()");
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1270, y: 810 });
    await sleep(400);
  };
  const closeMenu = async () => { if (!(await menuOpen())) await click('#menu-btn'); await sleep(200); };
  await main.ev("process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].setContentSize(1280,820)");
  await until('!!window.vsApi');
  await ev("vsApi.setTheme('light')");
  await ev("vsApi.saveProfile({name:'Гость'})");
  const t = new Date(), p2 = v => String(v).padStart(2, '0');
  const day = d => { const x = new Date(t); x.setDate(x.getDate() + d); return `${x.getFullYear()}-${p2(x.getMonth() + 1)}-${p2(x.getDate())}`; };
  await ev(`(async () => {
    await vsApi.savePrompt({ item: { title: 'Неоновый портрет под дождём', type: 'Статика', text: 'cinematic portrait of a woman under neon rain, wet asphalt reflections, 85mm lens, shallow depth of field' } });
    await vsApi.savePrompt({ item: { title: 'Облёт замка на рассвете', type: 'Видео', text: 'slow drone orbit around an ancient stone castle at sunrise, low fog in the valley' } });
    await vsApi.calSave({ date: '${day(0)}', from: '11:00', to: '12:00', who: 'Дима', title: 'Мини-курс', kind: 'call', remind: 60, note: '' });
    await vsApi.calSave({ date: '${day(1)}', from: '10:00', to: '12:00', title: 'Монтаж YouTube', kind: 'edit', remind: 60, note: '' });
    await vsApi.calSave({ date: '${day(2)}', from: '15:00', to: '16:00', title: 'Съёмка рилса', kind: 'shoot', remind: 60, note: '' });
    await vsApi.taskSave({ title: 'Смонтировать рилс', status: 'todo', priority: 2, tags: ['Монтаж'], due: '${day(1)}' });
    await vsApi.taskSave({ title: 'Сценарий ролика про зиму', status: 'doing', tags: ['YouTube'] });
    return 1;
  })()`);
  // Refresh this window's own state after the direct API saves (sync is sent only to other windows).
  await page.send('Page.reload', {});
  await until("document.querySelector('#side-name')?.textContent === 'Гость'");
  await closeDialogs();
  await noGlass();
  await click('[data-page="home"]');
  await sleep(500);
  // Step 1, first frame: the usual light theme, «Тема» open in the profile menu.
  await openTheme(false);
  await shot('01-theme', { profile: '#menu-btn', theme: '.has-sub[data-sub="theme"]', macos: '.has-sub[data-sub="macos"]' });
  // Step 1, second frame: the macOS theme (light, peach) on «Главная».
  await click('.menu button[data-look="light"]');
  await click('.menu button[data-accent="peach"]');
  await until("document.documentElement.dataset.theme === 'macos' && document.documentElement.dataset.accent === 'peach'");
  await closeMenu();
  await sleep(500);
  await shot('01b-result', { side: '.side', tab: '.tab.on', tiles: '.home-grid', qa: '#qa-btn' });
  // Step 2, first frame: «macOS ›» with the look and the accent colours.
  await openTheme(true);
  await shot('02-sub', { macos: '.has-sub[data-sub="macos"]', look: '.mac-look', accents: '.mac-sub [aria-label="Акцент"]', help: '.mac-sub [data-guide="theme"]' });
  // Step 2, second frame: dark look with the blue accent, in the calendar.
  await click('.menu button[data-look="dark"]');
  await click('.menu button[data-accent="blue"]');
  await closeMenu();
  await click('[data-page="calendar"]');
  await until('!!document.querySelector(".cal-cell.today")');
  await sleep(600);
  await shot('02b-dark', { add: '#cal-add', bar: '#cbar', nav: '.nav-icon[aria-current="page"]', qa: '#qa-btn' });
  // Step 3: going back to the usual look.
  await openTheme(false);
  await shot('03-back', { light: '.menu button[data-theme="light"]', system: '.menu button[data-theme="system"]', macos: '.has-sub[data-sub="macos"]' });
  await closeMenu();
  return shot.boxes;
};
