const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (ch) => (fn) => ipcRenderer.on(ch, (_e, ...a) => fn(...a));

contextBridge.exposeInMainWorld('sb', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (cfg) => ipcRenderer.send('config:save', cfg),
  env: () => ipcRenderer.invoke('env'),
  hello: () => ipcRenderer.invoke('daemon:hello'),
  uuid: () => ipcRenderer.invoke('uuid'),

  spawn: (opts) => ipcRenderer.invoke('pty:spawn', opts),
  snapshot: (id) => ipcRenderer.invoke('pty:snapshot', id),
  cwd: (id) => ipcRenderer.invoke('pty:cwd', id),
  write: (id, d) => ipcRenderer.send('pty:write', id, d),
  resize: (id, c, r) => ipcRenderer.send('pty:resize', id, c, r),
  kill: (id) => ipcRenderer.send('pty:kill', id),
  quitAll: () => ipcRenderer.invoke('quit-all'),

  claudeStates: () => ipcRenderer.invoke('claude:states'),
  git: (paths) => ipcRenderer.invoke('git', paths),
  pickFolder: () => ipcRenderer.invoke('dialog:folder'),
  popup: (items) => ipcRenderer.invoke('menu:popup', items),
  reveal: (p) => ipcRenderer.send('reveal', p),
  openEditor: (p) => ipcRenderer.send('open-editor', p),
  openExternal: (u) => ipcRenderer.send('open-external', u),
  badge: (n) => ipcRenderer.send('badge', n),
  notify: (o) => ipcRenderer.send('notify', o),
  pathForFile: (f) => webUtils.getPathForFile(f),

  onData: on('pty:data'),
  onExit: on('pty:exit'),
  onProcs: on('pty:procs'),
  procsNow: () => ipcRenderer.send('pty:procs-now'),
  onClaude: on('claude:event'),
  onMenu: on('menu'),
  onFocusPane: on('focus-pane'),
  onWindowFocus: on('window:focus'),
  onReconnected: on('daemon:reconnected'),
});
