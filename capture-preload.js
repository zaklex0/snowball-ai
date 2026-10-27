'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('vsApi', {
  captureList: () => ipcRenderer.invoke('capture-list'),
  captureDelete: (id, token) => ipcRenderer.invoke('capture-delete', id, token),
  captureRestore: (undo, token) => ipcRenderer.invoke('capture-restore', undo, token),
  captureGuide: () => ipcRenderer.invoke('capture-guide'),
  captureGet: (id, token) => ipcRenderer.invoke('capture-get', id, token),
  captureSave: (id, token, value) => ipcRenderer.invoke('capture-save', id, token, value),
  captureCopy: (id, token, bytes) => ipcRenderer.invoke('capture-copy', id, token, bytes),
  captureStart: () => ipcRenderer.invoke('capture-start'),
  captureImport: () => ipcRenderer.invoke('capture-import'),
  captureShortcut: (key) => ipcRenderer.invoke('capture-shortcut', key),
  onCaptureChanged: (fn) => {
    const f = (_e, value) => fn(value);
    ipcRenderer.on('capture-changed', f);
    return () => ipcRenderer.removeListener('capture-changed', f);
  },
  onCaptureOpen: (fn) => {
    const f = (_e, id) => fn(id);
    ipcRenderer.on('capture-open', f);
    return () => ipcRenderer.removeListener('capture-open', f);
  },
  onCaptureTheme: (fn) => {
    const f = (_e, theme) => fn(theme);
    ipcRenderer.on('capture-theme', f);
    return () => ipcRenderer.removeListener('capture-theme', f);
  },
  captureInit: () => ipcRenderer.invoke('capture-init'),
  captureChoose: (rect) => ipcRenderer.invoke('capture-choose', rect),
  captureCancel: () => ipcRenderer.invoke('capture-cancel'),
});
