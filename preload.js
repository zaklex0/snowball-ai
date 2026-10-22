'use strict';
// The only bridge between the window and the disk: the page asks, main.js does the work.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('vsApi', {
  platform: process.platform,
  load: () => ipcRenderer.invoke('load'),
  savePrompt: (payload) => ipcRenderer.invoke('save-prompt', payload),
  deletePrompt: (id) => ipcRenderer.invoke('delete-prompt', id),
  addFiles: (promptId, sources) => ipcRenderer.invoke('add-files', promptId, sources),
  removeFile: (promptId, fileId) => ipcRenderer.invoke('remove-file', promptId, fileId),
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  openFile: (promptId, fileId) => ipcRenderer.invoke('open-file', promptId, fileId),
  showFile: (promptId, fileId) => ipcRenderer.invoke('show-file', promptId, fileId),
  copyText: (text, promptId) => ipcRenderer.invoke('copy-text', text, promptId),
  pickAvatar: () => ipcRenderer.invoke('pick-avatar'),
  saveProfile: (input) => ipcRenderer.invoke('save-profile', input),
  setTheme: (theme) => ipcRenderer.invoke('set-theme', theme),
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  openDataDir: () => ipcRenderer.invoke('open-data-dir'),
  changeDataDir: () => ipcRenderer.invoke('change-data-dir'),
  exportJson: () => ipcRenderer.invoke('export'),
  importJson: () => ipcRenderer.invoke('import'),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file) || ''; } catch (e) { return ''; } },
  onDataChanged: (fn) => {
    const listener = (_e, prompts) => fn(prompts);
    ipcRenderer.on('data-changed', listener);
    return () => ipcRenderer.removeListener('data-changed', listener);
  },
  onUpdate: (fn) => {
    const listener = (_e, u) => fn(u);
    ipcRenderer.on('update', listener);
    return () => ipcRenderer.removeListener('update', listener);
  }
});
