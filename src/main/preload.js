const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const listen = (channel) => (callback) => {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('api', {
  checkTools: invoke('tools:check'),
  loadLibrary: invoke('library:load'),
  saveLibrary: invoke('library:save'),
  videoInfo: invoke('video:info'),
  loadVideo: invoke('video:load'),
  prepareVideo: invoke('video:prepare'),
  removeVideo: invoke('video:remove'),
  startExport: invoke('export:start'),
  cancelExport: invoke('export:cancel'),
  chooseFolder: invoke('dialog:chooseFolder'),
  confirm: invoke('dialog:confirm'),
  showFile: invoke('shell:showFile'),
  cacheUsage: invoke('cache:usage'),
  clearCache: invoke('cache:clear'),
  onVideoProgress: listen('video:progress'),
  onExportProgress: listen('export:progress'),
});
