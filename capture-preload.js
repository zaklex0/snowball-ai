'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('vsApi', {
  captureList: () => ipcRenderer.invoke('capture-list'),
  captureDelete: (id, token) => ipcRenderer.invoke('capture-delete', id, token),
  captureRestore: (undo, token) => ipcRenderer.invoke('capture-restore', undo, token),
  captureGuide: () => ipcRenderer.invoke('capture-guide'),
  captureGet: (id, token) => ipcRenderer.invoke('capture-get', id, token),
  captureSave: (id, token, value) => ipcRenderer.invoke('capture-save', id, token, value),
  captureCopy: (id, token, bytes) => ipcRenderer.invoke('capture-copy', id, token, bytes),
  captureStart: () => ipcRenderer.invoke('capture-start'),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file) || ''; } catch (e) { return ''; } },
  captureImport: (filePath) => ipcRenderer.invoke('capture-import', filePath),
  captureShortcut: (key) => ipcRenderer.invoke('capture-shortcut', key),
  captureState: () => ipcRenderer.invoke('capture-state'),
  captureRecording: (begin) => ipcRenderer.invoke('capture-recording', begin),
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
  // The selection window: a screen picture arrives as raw pixels, the window says when it has drawn it.
  onCaptureFrame: (fn) => {
    const f = (_e, frame) => fn(frame);
    ipcRenderer.on('capture-frame', f);
    return () => ipcRenderer.removeListener('capture-frame', f);
  },
  onCaptureReset: (fn) => {
    const f = () => fn();
    ipcRenderer.on('capture-reset', f);
    return () => ipcRenderer.removeListener('capture-reset', f);
  },
  captureReady: () => ipcRenderer.invoke('capture-ready'),
  captureChoose: (rect) => ipcRenderer.invoke('capture-choose', rect),
  captureCancel: () => ipcRenderer.invoke('capture-cancel'),
});
