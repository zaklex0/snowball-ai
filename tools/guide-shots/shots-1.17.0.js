// Public guide for the call summaries in the calendar: only example people and example text, in the runner's isolated profile.
module.exports = async function ({ main, page, shot }) {
  const { ev, until, sleep } = page;
  const click = selector => ev(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const clickText = (scope, text) => ev(`[...document.querySelectorAll(${JSON.stringify(scope)})].find(b => b.textContent.includes(${JSON.stringify(text)})).click()`);
  const closeDialogs = () => ev("document.querySelectorAll('dialog[open]').forEach(d => d.close())");
  await main.ev("process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].setContentSize(1280,820)");
  await until('!!window.vsApi');
  await ev("vsApi.setTheme('light')");
  await ev("vsApi.saveProfile({name:'Гость'})");
  await ev("vsApi.assistantCheckKey('openai','sk-guide-0000000000')");
  const t = new Date(), p2 = v => String(v).padStart(2, '0');
  const today = `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())}`;
  const call = await ev(`vsApi.calSave({ date: '${today}', from: '11:00', to: '12:00', who: 'Дима', title: 'Мини-курс', kind: 'call', remind: 60, note: '' })`);
  await ev(`vsApi.calSave({ date: '${today}', from: '15:00', to: '15:30', who: 'Оля', title: 'Правки по сценарию', kind: 'meet', remind: 60, note: '' })`);
  // Refresh this window's own state after the direct API saves (sync is sent only to other windows).
  await page.send('Page.reload', {});
  await until("document.querySelector('#side-name')?.textContent === 'Гость'");
  await closeDialogs();
  await click('[data-page="calendar"]');
  await until('!!document.querySelector("#cal-recap-btn") && !!document.querySelector(".cal-ev")');
  await sleep(500);
  // Step 1, second frame: the window for loading a summary.
  await click('#cal-recap-btn');
  await until('document.getElementById("recap-dlg").open');
  await ev(`(() => { const s = document.getElementById('rd-event'); s.value = ${JSON.stringify(call.id)}; s.dispatchEvent(new Event('change')); return 1; })()`);
  await ev(`(() => { const t = document.getElementById('rd-text'); t.value = ${JSON.stringify('Дима: Давай коротко про мини-курс. Я накидаю структуру, а ты подготовишь идеи и примеры.\nГость: Хорошо. Завтра пришлю концепт. Курс делаем коротким, до 30 минут, а финал — с лёгким монтажом.\nДима: Договорились. Созвонимся завтра в 12:00.')}; return 1; })()`);
  await shot('01b-load', { event: '#rd-event', text: '#rd-text', file: '#rd-file', go: '#rd-go' });
  await click('#rd-go');
  await until('!!document.querySelector("#cal-recap .rc-step")');
  await closeDialogs();
  await sleep(300);
  // Step 1, first frame: the calendar with the assistant bar, the button and the leaf on the event.
  await shot('01-where', { bar: '#cbar', load: '#cal-recap-btn', flag: '.cal-ev .flag', help: '#cal-help' });
  // Step 2: the event opens on «Дело», the summary is one button away.
  await ev(`document.querySelector('.cal-ev .flag').closest('.cal-ev').click()`);
  await until('document.getElementById("cal-dialog").open && !document.getElementById("cal-tabs").hidden');
  await shot('02-open', { form: '#cal-form', tabs: '#cal-tabs', sum: '#cal-tab-sum', tr: '#cal-tab-tr' });
  await click('#cal-tab-sum');
  await until('!!document.querySelector("#cal-recap .rc-step")');
  await shot('02b-recap', { tabs: '#cal-tabs', brief: '#cal-recap .rc-blk:nth-child(2)', decisions: '#cal-recap .rc-blk:nth-child(3)', steps: '#cal-recap .rc-blk:nth-child(4)' });
  // Step 3: next steps and the call that was agreed on.
  await ev(`(() => { let e = document.querySelector('#cal-recap'); while (e && e.scrollHeight <= e.clientHeight + 2) e = e.parentElement; if (e) e.scrollTop = e.scrollHeight; return 1; })()`);
  await sleep(300);
  await shot('03-steps', { mine: '#cal-recap .rc-step:not(.other)', other: '#cal-recap .rc-step.other', add: '#cal-recap .rc-act .btn-primary', meet: '#cal-recap .rc-meet button' });
  await clickText('#cal-recap button', 'Добавить на доску');
  await sleep(900);
  await closeDialogs();
  await click('[data-page="tasks"]');
  await until('document.querySelectorAll(".task").length >= 2');
  await sleep(500);
  await shot('03b-board', { column: '.tcol:first-child', card: '.task', tag: '.task .task-marks' });
  // Step 4: the text and the search.
  await click('[data-page="calendar"]');
  await until('!!document.querySelector(".cal-ev .flag")');
  await ev(`document.querySelector('.cal-ev .flag').closest('.cal-ev').click()`);
  await until('document.getElementById("cal-dialog").open');
  await click('#cal-tab-tr');
  await until('!!document.querySelector("#cal-recap .rc-search input")');
  await ev(`(() => { const i = document.querySelector('#cal-recap .rc-search input'); i.value = 'концепт'; i.dispatchEvent(new Event('input')); return 1; })()`);
  await sleep(300);
  await shot('04-text', { tab: '#cal-tab-tr', search: '#cal-recap .rc-search', lines: '#cal-recap .rc-lines', foot: '#cal-recap .rc-foot' });
  return shot.boxes;
};
