'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
for (const name of ['task-subgroups.html', 'task-subgroups-column-numbers.html']) {
  const file = path.join(root, 'mockups', name);
  let html = fs.readFileSync(file, 'utf8');
  if (!html.includes('<script src="task-number-stamp.js">')) html = html.replace('<script>', '<script src="task-number-stamp.js"></script>\n<script>');
  html = html.replace(/ function numberCircle\(t\)\{[^\n]*\}/, ` function numberCircle(t){const b=button('','task-circle',e=>{e.stopPropagation();move(t.id,t.status==='done'?'todo':'done')},t.status==='done'?'Вернуть в «Предстоит»':'Отметить готовой');const n=columnNumber(t);b.setAttribute('aria-label','Задача '+n+': '+(t.status==='done'?'вернуть в Предстоит':'отметить готовой'));b.dataset.numberToStamp=n;return b}`);
  fs.writeFileSync(file, html);
}
require('./make-subgroups-macos.cjs');
