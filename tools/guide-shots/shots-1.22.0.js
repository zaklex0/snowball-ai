// Demo tasks in the guide runner's isolated profile only.
module.exports = async function ({ main, page, shot }) {
  const { ev, until, sleep } = page;
  await main.ev("process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].setContentSize(1280,820)");
  await until('!!window.vsApi && document.querySelectorAll(".tab").length > 0');
  const ids = await ev(`(async()=>{
    await vsApi.setTheme('light'); await vsApi.saveProfile({name:'Гость'});
    const cols=[]; for(const name of ['YouTube','Обучение','Личное']) cols.push((await vsApi.columnAdd(name)).columnId);
    const parent=(await vsApi.taskSave({title:'Подготовить новый выпуск',note:'Сценарий, съёмка и обложка',status:'todo'})).taskId;
    const child=(await vsApi.taskSave({title:'Собрать референсы',note:'Сохранить примеры света и композиции',status:'todo',subtasks:[{title:'Выбрать три примера'}]})).taskId;
    await vsApi.taskSave({title:'Монтаж выпуска',status:'doing',tags:['YouTube']});
    await vsApi.taskSave({title:'Идеи для Shorts',status:cols[0]});
    await vsApi.taskSave({title:'Урок по свету',status:cols[1]});
    return {parent,child};
  })()`);
  async function reload() {
    await ev('window.guideReloadMark=true;true'); await page.send('Page.reload',{});
    await until('!window.guideReloadMark && document.querySelector("#side-name")?.textContent === "Гость"');
    await ev('document.querySelectorAll("dialog[open]").forEach(d=>d.close());document.querySelector("[data-page=tasks]").click();true');
    await until('document.querySelectorAll(".tcol").length===6');
    await sleep(200);
  }
  await reload();
  await shot('01-board',{add:'#task-column-add',scroll:'#task-board-nav'});
  await ev(`(()=>{const card=document.querySelector('.task[data-id="${ids.parent}"]'),r=card.getBoundingClientRect();card.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.left+70,clientY:r.top+20}));document.querySelector('.task-ctx [data-task-action=move]').click();return true;})()`);
  await shot('02-move',{menu:'.task-ctx'});
  await ev(`vsApi.taskSave({id:${JSON.stringify(ids.child)},parentId:${JSON.stringify(ids.parent)}})`);
  await reload();
  await ev(`document.querySelector('.task[data-id="${ids.parent}"]').click();true`);
  await until('!document.querySelector("#tpanel").hidden');
  await shot('03-nested',{counter:'.task .task-marks',children:'.tp-subs .tp-sub[data-task-id]'});
  await ev('document.querySelector(".task-child-open").click();true');
  await shot('04-details',{detach:{sel:'#tpanel button',text:'Сделать отдельной задачей'}});
  return shot.boxes;
};
