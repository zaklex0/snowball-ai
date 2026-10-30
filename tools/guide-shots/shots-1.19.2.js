// Public guide for the folded sidebar: only example data («Гость», example events and tasks) in the runner's isolated profile.
module.exports = async function ({ main, page, shot }) {
  const { ev, until, sleep } = page;
  const click = selector => ev(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const closeDialogs = () => ev("document.querySelectorAll('dialog[open]').forEach(d => d.close())");
  await main.ev("process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].setContentSize(1280,820)");
  await until('!!window.vsApi');
  await ev("vsApi.setTheme('light')");
  await ev("vsApi.saveProfile({name:'Гость'})");
  const t = new Date(), p2 = v => String(v).padStart(2, '0');
  const day = d => { const x = new Date(t); x.setDate(x.getDate() + d); return `${x.getFullYear()}-${p2(x.getMonth() + 1)}-${p2(x.getDate())}`; };
  await ev(`(async () => {
    await vsApi.calSave({ date: '${day(0)}', from: '23:00', to: '23:50', who: 'Дима', title: 'Мини-курс', kind: 'call', remind: 60, note: '' });
    await vsApi.calSave({ date: '${day(1)}', from: '10:00', to: '12:00', title: 'Монтаж YouTube', kind: 'edit', remind: 60, note: '' });
    await vsApi.calSave({ date: '${day(2)}', from: '15:00', to: '16:00', title: 'Съёмка рилса', kind: 'shoot', remind: 60, note: '' });
    await vsApi.taskSave({ title: 'Смонтировать рилс', status: 'todo', priority: 2, tags: ['Монтаж'], due: '${day(1)}' });
    await vsApi.taskSave({ title: 'Сценарий ролика про зиму', status: 'doing', tags: ['YouTube'] });
    return 1;
  })()`);
  // Refresh this window's own state after the direct API saves (sync is sent only to other windows).
  await ev("localStorage.removeItem('sideMini')");
  await page.send('Page.reload', {});
  await until("document.querySelector('#side-name')?.textContent === 'Гость'");
  await closeDialogs();
  await click('[data-page="calendar"]');
  await until('!!document.querySelector(".cal-cell.today")');
  await sleep(500);
  // Step 1, first frame: the usual wide panel and its new button.
  await shot('01-button', { toggle: '#side-toggle' });
  // Step 1, second frame: the panel folded into a strip of icons.
  await click('#side-toggle');
  await sleep(500);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1270, y: 810 });
  await shot('01b-folded', { toggle: '#side-toggle', icons: '.side-icons', capture: '.capture-nav', bottom: '.side-bottom' });
  // Step 2: the timer runs, its panel opens to the right of the strip.
  await click('.timer-main');
  await sleep(200);
  await ev("[...document.querySelectorAll('.timer-presets button')].find(b => b.textContent === '25 мин').click()");
  await sleep(1500);
  await click('.timer-main');
  await ev("document.activeElement && document.activeElement.blur()");
  await sleep(400);
  await shot('02-timer', { timer: '.timer-row', pop: '#timer-pop' });
  await click('.timer-main');
  await ev("vsApi.timer('stop')");
  await click('#side-toggle');
  return shot.boxes;
};
