'use strict';
module.exports = async function ({ main, page, shot }) {
  const { ev, until, sleep } = page;
  await main.ev("process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].setContentSize(1280,820)");
  await until('!!window.vsApi && document.querySelectorAll(".tab").length > 0');
  const ids = await ev(`(async()=>{
    await vsApi.setTheme('light');await vsApi.saveProfile({name:'Гость'});await vsApi.tasksArchiveMode('manual');
    const youtube=(await vsApi.taskGroupAdd('YouTube')).groupId,course=(await vsApi.taskGroupAdd('Курс')).groupId,work=(await vsApi.taskGroupAdd('Работа')).groupId;
    const parent=(await vsApi.taskSave({title:'Подготовить выпуск',groupId:youtube,note:'Сценарий, съёмка и обложка',tags:['Видео']})).taskId;
    const child=(await vsApi.taskSave({title:'Собрать референсы',groupId:youtube,note:'Выбрать примеры света и композиции',tags:['Референсы']})).taskId;
    if(!child)throw Error('Demo child task could not be created');
    await vsApi.taskSave({id:child,parentId:parent});
    const lesson=(await vsApi.taskSave({title:'Записать вводный урок',groupId:course,tags:['Запись']})).taskId;
    await vsApi.taskSave({title:'Согласовать правки',groupId:work,tags:['Правки']});
    const montage=(await vsApi.taskSave({title:'Смонтировать короткий ролик',groupId:youtube,status:'doing',tags:['Монтаж']})).taskId;
    return {youtube,course,work,parent,child,lesson,montage};
  })()`);
  async function reload() {
    await page.send('Page.reload');
    await until('document.querySelector("#side-name")?.textContent === "Гость"');
    await ev('document.querySelectorAll("dialog[open]").forEach(d=>d.close());document.querySelector("[data-page=tasks]").click();true');
    await until('document.querySelectorAll(".task-group").length>=4'); await sleep(180);
  }
  await reload();
  await shot('01-board',{groups:'.tc-todo .task-group',add:'.task-group-add',plus:'.tc-todo .task-group-plus',numbers:'.tc-doing .tchk.numbered'});
  await ev('document.querySelector(".task-group-add").click();document.querySelector(".task-group-input").value="Личное";true');
  await shot('02-group-form',{name:'.task-group-input',save:'.task-group-form .btn-mini'});
  await ev('Array.from(document.querySelectorAll(".task-group-form button")).find(b=>b.textContent==="Отмена").click();true');
  await ev(`document.querySelector('.tc-todo .task-group[data-group="${ids.course}"] .task-group-plus').click();document.querySelector('.task-input').value='Проверить материалы урока';true`);
  await shot('03-add-task',{input:'.task-input',plus:`.tc-todo .task-group[data-group="${ids.course}"] .task-group-plus`});
  await ev('document.querySelector(".task-input").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));true');
  await ev(`vsApi.taskSave({id:${JSON.stringify(ids.lesson)},status:'doing'})`); await reload();
  await shot('04-move',{group:`.tc-doing .task-group[data-group="${ids.course}"]`,number:`.task[data-id="${ids.lesson}"] .tchk`});
  await ev('const t=document.querySelector("#tbar-input");t.value="Перенеси задачу 1 из В процессе в Готово";t.dispatchEvent(new Event("input",{bubbles:true}));true');
  await shot('05-assistant',{input:'#tbar-input',source:'.tc-doing .task .tchk',send:'#tbar-send'});
  await ev('document.querySelector("#tbar-input").value="";true');
  await ev(`document.querySelector('.task[data-id="${ids.lesson}"]').click();true`);
  await shot('06-details',{group:'.task-group-select',column:'#tpanel .tp-field',number:'#tpanel .tchk.numbered'});
  await ev('document.querySelector(".tp-close").click();true');
  await ev(`(()=>{const card=document.querySelector('.task[data-id="${ids.parent}"]'),r=card.getBoundingClientRect();card.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.left+70,clientY:r.top+20}));document.querySelector('.task-ctx [data-task-action=move]').click();return true})()`);
  await shot('07-context',{menu:'.task-ctx',columns:'#task-column-add'});
  await ev('document.querySelector(".task-ctx").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));true');
  await ev(`vsApi.taskSave({id:${JSON.stringify(ids.child)},parentId:${JSON.stringify(ids.parent)}})`);await reload();
  await ev(`document.querySelector('.task[data-id="${ids.parent}"]').click();true`);
  await shot('08-nested',{children:'.tp-subs .tp-sub[data-task-id]',counter:'.task .task-marks'});
  await ev('document.querySelector(".task-child-open").click();true');
  await shot('09-detach',{detach:{sel:'#tpanel button',text:'Сделать отдельной задачей'}});
  return shot.boxes;
};
