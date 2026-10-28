const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lumenHost', {
  getAll: () => ipcRenderer.sendSync('cfg:all'),
  set: (key, value) => ipcRenderer.invoke('cfg:set', key, value),
  log: (msg) => ipcRenderer.send('log', String(msg)),
  keepAwake: (on) => ipcRenderer.send('power:keepAwake', !!on),
  isElectron: true,
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    info: () => ipcRenderer.invoke('update:info'),
    install: () => ipcRenderer.invoke('update:install'),
    onReady: (cb) => ipcRenderer.on('update:ready', (_e, d) => cb(d)),
  },
  onClosing: (cb) => ipcRenderer.on('app:closing', () => cb()),
  canClose: () => ipcRenderer.send('app:can-close'),
  // Controls window that sits over the embedded mpv video.
  overlay: {
    send: (data) => ipcRenderer.send('overlay:data', data),
    onData: (cb) => ipcRenderer.on('overlay:data', (_e, d) => cb(d)),
    ready: () => ipcRenderer.send('overlay:ready'),
  },
  win: {
    fullscreen: () => ipcRenderer.send('win:fullscreen'),
    player: (on) => ipcRenderer.send('win:player', !!on),
    onFullscreen: (cb) => ipcRenderer.on('win:fullscreen-changed', (_e, on) => cb(on)),
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close'),
    moveBy: (dx, dy) => ipcRenderer.send('win:move-by', dx, dy),
  },
  mpv: {
    available: () => ipcRenderer.invoke('mpv:available'),
    start: (args, opts) => ipcRenderer.invoke('mpv:start', args, opts),
    command: (cmd) => ipcRenderer.invoke('mpv:command', cmd),
    stop: () => ipcRenderer.invoke('mpv:stop'),
    onEvent: (cb) => {
      const fn = (_e, evt) => cb(evt);
      ipcRenderer.on('mpv:event', fn);
      return () => ipcRenderer.removeListener('mpv:event', fn);
    },
  },
});
