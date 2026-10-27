'use strict';
// The only bridge between the window and the disk: the page asks, main.js does the work.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('vsApi', {
  captureList: () => ipcRenderer.invoke('capture-list'),
  captureDelete: (id, token) => ipcRenderer.invoke('capture-delete', id, token),
  captureRestore: (undo, token) => ipcRenderer.invoke('capture-restore', undo, token),
  captureGuide: () => ipcRenderer.invoke('capture-guide'),
  onCaptureGuide: fn => { const f = () => fn(); ipcRenderer.on('capture-guide', f); return () => ipcRenderer.removeListener('capture-guide', f); },
  captureGet: (id, token) => ipcRenderer.invoke('capture-get', id, token),
  captureSave: (id, token, value) => ipcRenderer.invoke('capture-save', id, token, value),
  captureCopy: (id, token, bytes) => ipcRenderer.invoke('capture-copy', id, token, bytes),
  captureStart: () => ipcRenderer.invoke('capture-start'),
  captureImport: () => ipcRenderer.invoke('capture-import'),
  captureShortcut: key => ipcRenderer.invoke('capture-shortcut', key),
  onCaptureChanged: fn => { const f = (_e, value) => fn(value); ipcRenderer.on('capture-changed', f); return () => ipcRenderer.removeListener('capture-changed', f); },
  onCaptureOpen: fn => { const f = (_e, id) => fn(id); ipcRenderer.on('capture-open', f); return () => ipcRenderer.removeListener('capture-open', f); },
  onCaptureTheme: fn => { const f = (_e, theme) => fn(theme); ipcRenderer.on('capture-theme', f); return () => ipcRenderer.removeListener('capture-theme', f); },
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
  setTabs: (tabs) => ipcRenderer.invoke('set-tabs', tabs),
  windowOpen: (tabs, mode, point) => ipcRenderer.invoke('window-open', tabs, mode, point),
  windowReturn: (tab, x) => ipcRenderer.invoke('window-return', tab, x),
  // A separate window is dragged over this window's tab strip ({ x } or null when it leaves).
  onTabHover: (fn) => {
    const listener = (_e, at) => fn(at);
    ipcRenderer.on('tab-hover', listener);
    return () => ipcRenderer.removeListener('tab-hover', listener);
  },
  // A tab comes back from a separate window: { tab, x }.
  onTabInsert: (fn) => {
    const listener = (_e, d) => fn(d);
    ipcRenderer.on('tab-insert', listener);
    return () => ipcRenderer.removeListener('tab-insert', listener);
  },
  // This separate window was let go over the main window's tab strip: { x }.
  onReturnTab: (fn) => {
    const listener = (_e, at) => fn(at);
    ipcRenderer.on('return-tab', listener);
    return () => ipcRenderer.removeListener('return-tab', listener);
  },
  onSync: (fn) => {
    const listener = (_e, data) => fn(data);
    ipcRenderer.on('sync', listener);
    return () => ipcRenderer.removeListener('sync', listener);
  },
  timer: (cmd, arg) => ipcRenderer.invoke('timer', cmd, arg),
  onTimer: (fn) => {
    const listener = (_e, t) => fn(t);
    ipcRenderer.on('timer', listener);
    return () => ipcRenderer.removeListener('timer', listener);
  },
  onWindowMain: (fn) => {
    const listener = () => fn();
    ipcRenderer.on('window-main', listener);
    return () => ipcRenderer.removeListener('window-main', listener);
  },
  setConfirm: (on) => ipcRenderer.invoke('set-confirm', on),
  updateState: () => ipcRenderer.invoke('update-state'),
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  openDataDir: () => ipcRenderer.invoke('open-data-dir'),
  changeDataDir: () => ipcRenderer.invoke('change-data-dir'),
  backupExport: () => ipcRenderer.invoke('backup-export'),
  promptsExport: (ids) => ipcRenderer.invoke('prompts-export', ids),
  archiveOpen: (file) => ipcRenderer.invoke('archive-open', file),
  onArchiveOpened: (fn) => {
    const listener = (_e, r) => fn(r);
    ipcRenderer.on('archive-opened', listener);
    return () => ipcRenderer.removeListener('archive-opened', listener);
  },
  assistantSend: (messages, opts) => ipcRenderer.invoke('assistant-send', messages, opts),
  assistantStop: (id) => ipcRenderer.invoke('assistant-stop', id),
  assistantReset: () => ipcRenderer.invoke('assistant-reset'),
  assistantDecide: (actionId, accept) => ipcRenderer.invoke('assistant-decide', actionId, accept),
  assistantUndo: (actionId) => ipcRenderer.invoke('assistant-undo', actionId),
  taskSave: (t) => ipcRenderer.invoke('task-save', t),
  taskDelete: (id) => ipcRenderer.invoke('task-delete', id),
  taskRestore: (t) => ipcRenderer.invoke('task-restore', t),
  columnAdd: (name) => ipcRenderer.invoke('column-add', name),
  columnRename: (id, name) => ipcRenderer.invoke('column-rename', id, name),
  columnMove: (id, dir) => ipcRenderer.invoke('column-move', id, dir),
  columnDelete: (id) => ipcRenderer.invoke('column-delete', id),
  columnRestore: (r) => ipcRenderer.invoke('column-restore', r),
  tasksArchive: (ids) => ipcRenderer.invoke('tasks-archive', ids),
  tasksUnarchive: (ids) => ipcRenderer.invoke('tasks-unarchive', ids),
  tasksArchiveMode: (mode) => ipcRenderer.invoke('tasks-archive-mode', mode),
  // Done tasks went to the archive by themselves: how many.
  onTasksArchived: (fn) => {
    const listener = (_e, n) => fn(n);
    ipcRenderer.on('tasks-archived', listener);
    return () => ipcRenderer.removeListener('tasks-archived', listener);
  },
  tasksAssistant: (text) => ipcRenderer.invoke('tasks-assistant', text),
  tasksAssistantUndo: (undoId) => ipcRenderer.invoke('tasks-assistant-undo', undoId),
  calSave: (ev) => ipcRenderer.invoke('cal-save', ev),
  calDelete: (id) => ipcRenderer.invoke('cal-delete', id),
  onCalendarOpen: (fn) => {
    const listener = (_e, date) => fn(date);
    ipcRenderer.on('calendar-open', listener);
    return () => ipcRenderer.removeListener('calendar-open', listener);
  },
  chatList: () => ipcRenderer.invoke('chat-list'),
  chatGet: (id) => ipcRenderer.invoke('chat-get', id),
  chatSave: (chat) => ipcRenderer.invoke('chat-save', chat),
  chatDelete: (id) => ipcRenderer.invoke('chat-delete', id),
  chatImageSave: (chatId, name, bytes, ext) => ipcRenderer.invoke('chat-image-save', chatId, name, bytes, ext),
  chatImageRemove: (chatId, stored) => ipcRenderer.invoke('chat-image-remove', chatId, stored),
  chatImageOpen: (chatId, stored) => ipcRenderer.invoke('chat-image-open', chatId, stored),
  mediaPick: () => ipcRenderer.invoke('media-pick'),
  mediaInfo: (file) => ipcRenderer.invoke('media-info', file),
  mediaRead: (file) => ipcRenderer.invoke('media-read', file),
  transcribePiece: (wav, prompt, model, seconds) => ipcRenderer.invoke('transcribe-piece', wav, prompt, model, seconds),
  transcribeDiarize: (wav, refs, seconds) => ipcRenderer.invoke('transcribe-diarize', wav, refs, seconds),
  transcriptList: () => ipcRenderer.invoke('transcript-list'),
  transcriptGet: (id) => ipcRenderer.invoke('transcript-get', id),
  transcriptSave: (t) => ipcRenderer.invoke('transcript-save', t),
  transcriptDelete: (id) => ipcRenderer.invoke('transcript-delete', id),
  transcriptRestore: (t) => ipcRenderer.invoke('transcript-restore', t),
  transcriptSummary: (id) => ipcRenderer.invoke('transcript-summary', id),
  transcriptCopy: (text) => ipcRenderer.invoke('transcript-copy', text),
  transcriptExport: (id, kind, content) => ipcRenderer.invoke('transcript-export', id, kind, content),
  transcriptShowSource: (id) => ipcRenderer.invoke('transcript-show-source', id),
  assistantCheckKey: (provider, key) => ipcRenderer.invoke('assistant-check-key', provider, key),
  assistantDeleteKey: (provider) => ipcRenderer.invoke('assistant-delete-key', provider),
  assistantSetOptions: (opts) => ipcRenderer.invoke('assistant-set-options', opts),
  assistantSetBalance: (provider, amount) => ipcRenderer.invoke('assistant-set-balance', provider, amount),
  setNotify: (on) => ipcRenderer.invoke('set-notify', on),
  onAssistantOpen: (fn) => {
    const listener = () => fn();
    ipcRenderer.on('assistant-open', listener);
    return () => ipcRenderer.removeListener('assistant-open', listener);
  },
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
