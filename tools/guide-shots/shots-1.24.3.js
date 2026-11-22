// Public guide for the prompts library. Only sample data in the runner's temporary profile.
module.exports = async function ({ main, page, shot }) {
  const { ev, until } = page;
  const click = selector => ev(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const search = text => ev(`(() => {
    const field = document.querySelector('#search');
    field.value = ${JSON.stringify(text)};
    field.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await main.ev("process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].setContentSize(1280,820)");
  await main.ev("process.mainModule.require('electron').clipboard.writeText = text => { global.guideCopiedPrompt = text; }; true");
  await until("!!window.vsApi && document.readyState === 'complete'");
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const date = [tomorrow.getFullYear(), tomorrow.getMonth() + 1, tomorrow.getDate()]
    .map((value, i) => String(value).padStart(i ? 2 : 4, '0')).join('-');
  const text = ['Начните с общего плана набережной.', 'Город отражается в воде.', 'Камера медленно движется вдоль берега.',
    'Первые лучи ложатся на крыши.', 'Пустая улица постепенно светлеет.', 'В конце кадра появляется янтарный мост.'].join('\n');
  await ev(`(async () => {
    await vsApi.setTheme('light');
    await vsApi.captureShortcut('Alt+F9');
    await vsApi.saveProfile({ name: 'Гость' });
    await vsApi.calSave({ date: ${JSON.stringify(date)}, from: '11:00', to: '12:00', title: 'Разбор раскадровки', kind: 'meet' });
    await vsApi.taskSave({ title: 'Подобрать свет для сцены', status: 'doing' });
    await vsApi.taskSave({ title: 'Проверить черновой монтаж', status: 'doing' });
    await vsApi.savePrompt({ item: {
      title: 'Свет в мастерской', type: 'Статика', text: 'Тёплый боковой свет из высокого окна. На столе лежит раскрытый альбом с набросками.'
    } });
    await vsApi.savePrompt({ item: {
      title: 'Город после дождя', type: 'Видео', text: ${JSON.stringify(text)}
    } });
  })()`);
  await page.send('Page.reload', {});
  await until("document.querySelector('#side-name').textContent === 'Гость' && document.querySelector('#home-recent button')");
  await ev("document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close())");
  await shot('01-home', { open: '#home-prompts', recent: '#home-recent' });

  await click('#home-prompts');
  await until("!document.querySelector('#view-prompts').hidden && document.querySelector('#rows .copy')");
  await shot('01b-library', { search: '#search' });

  await search('янтарный мост');
  await until("document.querySelector('.prompt-match-text:not([hidden]) mark')?.innerText === 'янтарный мост'");
  await shot('02-search', { count: '#prompt-search-count', match: '.prompt-match-text:not([hidden])' });

  await ev("document.querySelector('#search').focus()");
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
  await until("document.activeElement.matches('#rows .copy')");
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await until("document.querySelector('#rows .copy.done')");
  if (!await main.ev("global.guideCopiedPrompt?.endsWith('янтарный мост.')")) throw new Error('Wrong prompt copied');
  await shot('03-copy', { copy: '#rows .copy.done' });

  await click('.nav-icon[data-page="home"]');
  await ev("Array.from(document.querySelectorAll('#home-recent button')).find(b => b.innerText.includes('Свет в мастерской')).click()");
  await until("document.activeElement.closest('#rows tr')?.querySelector('.name')?.textContent === 'Свет в мастерской'");
  return shot.boxes;
};
