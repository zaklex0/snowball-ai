// The new-conversation button in a long LLM chat. Example text only, in the runner's isolated test profile.
module.exports = async function ({ main, page, shot }) {
  const { ev, until, sleep } = page;
  await main.ev("process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].setContentSize(1280,820)");
  await until('!!window.vsApi');
  await ev("vsApi.setTheme('light')");
  await ev("vsApi.saveProfile({name:'Гость'})");
  await page.send('Page.reload', {});
  await until("document.querySelector('#side-name')?.textContent === 'Гость'");
  await ev("document.querySelectorAll('dialog[open]').forEach(d => d.close())");
  await ev("document.querySelector('[data-page=assistant]').click()");
  await sleep(400);
  const questions = [
    'Помоги придумать промт для обложки короткого фильма. На ней одинокий человек стоит на пустой станции поздно вечером. Хочу, чтобы сразу чувствовались ожидание и тревога. Подскажи, какой свет, ракурс и детали окружения помогут передать это настроение.',
    'Давай уточним композицию. Человек должен быть маленьким в кадре, а станция — казаться огромной. На дальнем плане виден уходящий поезд и отражение холодного света на мокром полу. Как описать это для генератора, чтобы он не добавил лишних людей?',
    'Теперь сделаем второй вариант: тот же сюжет, но камера ближе к герою. За его плечом видна пустая платформа, на табло — последний поезд. Хочу сохранить кинематографичный свет, ощущение тишины и свободное место для названия фильма.'
  ];
  for (let i = 0; i < 8; i++) {
    await ev(`(() => { const input = document.getElementById('chat-input'); input.value = ${JSON.stringify(questions[i % questions.length])}; input.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('chat-send').click(); return 1; })()`);
    await until(`document.querySelectorAll('.msg-user').length >= ${i + 1}`);
    await until("!document.getElementById('composer').classList.contains('busy')", 30000);
  }
  await ev("document.getElementById('scroller').scrollTop = document.getElementById('scroller').scrollHeight");
  await until("!document.getElementById('chat-new-dock').hidden");
  await sleep(300);
  await shot('01-new-chat', { new: '#chat-new-dock' });
  return shot.boxes;
};
