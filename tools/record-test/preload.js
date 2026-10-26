const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('rec', {
  start: () => ipcRenderer.invoke('rec-start'),
  append: (name, data) => ipcRenderer.invoke('rec-append', name, data),
  files: () => ipcRenderer.invoke('rec-files'),
  openFolder: which => ipcRenderer.invoke('open-folder', which),
  list: () => ipcRenderer.invoke('rec-list'),
  transcribe: (name, key, models) => ipcRenderer.invoke('transcribe', name, key, models),
  onProgress: fn => ipcRenderer.on('tr-progress', (e, model) => fn(model)),
  readTrack: (name, track) => ipcRenderer.invoke('read-track', name, track),
  transcribePiece: (key, wav, prompt, model) => ipcRenderer.invoke('transcribe-piece', key, wav, prompt, model),
  pickFile: () => ipcRenderer.invoke('pick-file'),
  mediaInfo: file => ipcRenderer.invoke('media-info', file),
  pathOf: file => webUtils.getPathForFile(file),
  readMedia: file => ipcRenderer.invoke('read-media', file),
  saveMediaText: out => ipcRenderer.invoke('save-media-text', out),
  saveReport: (name, results) => ipcRenderer.invoke('save-report', name, results),
  dialogInfo: name => ipcRenderer.invoke('dialog-info', name),
  summarize: (name, key, opts) => ipcRenderer.invoke('summarize', name, key, opts),
  selftestDone: report => ipcRenderer.invoke('selftest-done', report)
});
