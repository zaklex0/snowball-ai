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
  assistantSend: (messages) => ipcRenderer.invoke('assistant-send', messages),
  assistantStop: (id) => ipcRenderer.invoke('assistant-stop', id),
  assistantReset: () => ipcRenderer.invoke('assistant-reset'),
  assistantDecide: (actionId, accept) => ipcRenderer.invoke('assistant-decide', actionId, accept),
  chatList: () => ipcRenderer.invoke('chat-list'),
  chatGet: (id) => ipcRenderer.invoke('chat-get', id),
  chatSave: (chat) => ipcRenderer.invoke('chat-save', chat),
  chatDelete: (id) => ipcRenderer.invoke('chat-delete', id),
  assistantCheckKey: (key) => ipcRenderer.invoke('assistant-check-key', key),
  assistantDeleteKey: () => ipcRenderer.invoke('assistant-delete-key'),
  assistantSetOptions: (opts) => ipcRenderer.invoke('assistant-set-options', opts),
  onAssistant: (fn) => {
    const listener = (_e, a) => fn(a);
    ipcRenderer.on('assistant', listener);
    return () => ipcRenderer.removeListener('assistant', listener);
  },
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
