const { app, BrowserWindow, ipcMain, dialog, Menu, shell, Notification, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { spawn: spawnProc, execFile } = require('child_process');

const HOME = os.homedir();
const CONFIG_DIR = process.env.SWITCHBOARD_CONFIG_DIR || path.join(HOME, '.config', 'switchboard');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const STATE_DIR = path.join(CONFIG_DIR, 'state'); // Claude hook events land here, one file per pane
const SOCK = path.join(CONFIG_DIR, 'ptyd.sock');
const HOOK_BIN = path.join(HOME, '.config', 'switchboard', 'bin', 'sb-hook');
const DAEMON_VERSION = 4;

const expand = (p) => (p && p.startsWith('~') ? path.join(HOME, p.slice(1)) : p);
const tildify = (p) => (p && p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p);

// ---------------------------------------------------------------- config
const DEFAULT_PROJECTS = {
  office: [
    ['seqrview', '~/Projects/seqrview'],
    ['seqrview-admin', '~/Projects/seqrview-admin'],
    ['seqr-admin-new', '~/Projects/seqr-admin-new'],
    ['seqrguard', '~/Projects/seqrguard'],
    ['GuardView', '~/Projects/GuardView'],
    ['guardview-qc', '~/Projects/guardview-qc'],
    ['shufflelab', '~/Projects/shufflelab'],
    ['innovatiview-ops-tools', '~/Projects/innovatiview-ops-tools'],
    ['mobile-android', '~/Projects/mobile-android'],
    ['dispatch-comms', '~/Documents/dispatch-comms'],
    ['otr-service-dev', '~/Desktop/otr-service-dev'],
  ],
  personal: [
    ['TouchDesigner', '~/Documents/td-projects'],
    ['touchdesigner-mcp', '~/Documents/touchdesigner-mcp'],
    ['portfolio', '~/Documents/portfolio'],
    ['pixel', '~/Desktop/Work&Misc/lores'],
    ['lights', '~/Desktop/lights-draft'],
    ['face-morph', '~/Documents/face-morph-attack-detection'],
    ['consensus', '~/Projects/consensus'],
    ['kev', '~/Projects/kev'],
    ['liveportrait', '~/Projects/liveportrait'],
    ['quantum2', '~/Projects/quantum2'],
    ['vantage', '~/Projects/vantage'],
    ['switchboard', '~/Projects/switchboard'],
  ],
};

function loadConfig() {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  if (!cfg) {
    cfg = { sections: {}, ui: {}, session: { active: 'office', tabs: [] } };
    for (const [key, list] of Object.entries(DEFAULT_PROJECTS)) {
      cfg.sections[key] = {
        label: key === 'office' ? 'Office' : 'Personal',
        projects: list.filter(([, p]) => fs.existsSync(expand(p))).map(([name, p]) => ({ name, path: p })),
      };
    }
    saveConfig(cfg);
  }
  cfg.ui = { fontSize: 13, fontFamily: "'SF Mono', Menlo, monospace", optionIsMeta: true, notify: true, ...cfg.ui };
  return cfg;
}
function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG_FILE);
}

// ---------------------------------------------------------------- claude hooks (opt-in)
// The app installs only the inert helper script. Registering it with Claude Code is
// the user's choice (see README); the app never edits ~/.claude/settings.json.
const HOOK_SCRIPT = `#!/bin/sh
# Switchboard: records Claude Code lifecycle events for the pane this session runs in.
# No-op outside Switchboard. Never blocks or alters Claude.
[ -n "$SWITCHBOARD_PANE" ] && [ -d "$SWITCHBOARD_STATE_DIR" ] || exit 0
f="$SWITCHBOARD_STATE_DIR/$SWITCHBOARD_PANE"
cat > "$f.tmp" 2>/dev/null && mv -f "$f.tmp" "$f.json" 2>/dev/null
exit 0
`;
function installHookScript() {
  fs.mkdirSync(path.dirname(HOOK_BIN), { recursive: true });
  if (!fs.existsSync(HOOK_BIN) || fs.readFileSync(HOOK_BIN, 'utf8') !== HOOK_SCRIPT) {
    fs.writeFileSync(HOOK_BIN, HOOK_SCRIPT, { mode: 0o755 });
  }
}
function hooksRegistered() {
  try {
    return fs.readFileSync(path.join(HOME, '.claude', 'settings.json'), 'utf8').includes('switchboard/bin/sb-hook');
  } catch { return false; }
}

// ---------------------------------------------------------------- daemon client
let sock = null;
let rbuf = '';
let rid = 1;
const pending = new Map();

function daemonEnv() {
  // Clean environment for shells: drop anything that would make a nested Claude
  // think it is inside another Claude/IDE session, and pin a UTF-8 locale.
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_|ELECTRON_|VSCODE_|ITERM_|TERM_SESSION_ID|__CF|NODE_OPTIONS)/.test(k)) continue;
    env[k] = v;
  }
  env.LANG = env.LANG || 'en_US.UTF-8';
  env.LC_CTYPE = env.LC_CTYPE || 'UTF-8';
  return env;
}

function connectOnce() {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(SOCK);
    s.setEncoding('utf8');
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}

function startDaemon() {
  spawnProc(process.execPath, [path.join(__dirname, 'ptyd.js'), SOCK], {
    detached: true,
    stdio: 'ignore',
    cwd: HOME,
    env: { ...daemonEnv(), ELECTRON_RUN_AS_NODE: '1' },
  }).unref();
}

function rawSend(msg) { sock?.write(JSON.stringify(msg) + '\n'); }
function request(msg) {
  return new Promise((resolve) => {
    if (!sock) return resolve({ error: 'Session service is not connected.' });
    const id = rid++;
    pending.set(id, resolve);
    rawSend({ ...msg, rid: id });
  });
}

function onDaemonLine(line) {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.t === 'hello') { pending.get('hello')?.(m); pending.delete('hello'); return; }
  if (m.rid && pending.has(m.rid)) { pending.get(m.rid)(m); pending.delete(m.rid); return; }
  if (!win || win.isDestroyed()) return;
  if (m.t === 'data') win.webContents.send('pty:data', m.id, m.d);
  else if (m.t === 'exit') win.webContents.send('pty:exit', m.id, m.code);
  else if (m.t === 'procs') win.webContents.send('pty:procs', m.procs);
}

function hello(s = sock) {
  return new Promise((resolve) => {
    pending.set('hello', resolve);
    s.write(JSON.stringify({ t: 'hello' }) + '\n');
  });
}

async function connectDaemon() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  let s;
  try { s = await connectOnce(); } catch {
    startDaemon();
    for (let i = 0; i < 60 && !s; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try { s = await connectOnce(); } catch {}
    }
  }
  if (!s) throw new Error('Could not start the session service.');
  sock = s;
  rbuf = '';
  s.on('data', (chunk) => {
    rbuf += chunk;
    let i;
    while ((i = rbuf.indexOf('\n')) >= 0) {
      const line = rbuf.slice(0, i);
      rbuf = rbuf.slice(i + 1);
      if (line) onDaemonLine(line);
    }
  });
  s.on('close', () => {
    if (sock === s) sock = null;
    if (!app.isQuitting) setTimeout(() => connectDaemon().then(() => win?.webContents.send('daemon:reconnected')).catch(() => {}), 500);
  });
  const h = await hello(s);
  // A daemon from an older build with nothing running gets replaced; one with live
  // sessions is kept so nothing is ever killed by an update.
  if (h.version !== DAEMON_VERSION && h.panes.length === 0) {
    s.removeAllListeners('close');
    s.write(JSON.stringify({ t: 'shutdown' }) + '\n');
    await new Promise((r) => setTimeout(r, 600));
    s.destroy();
    sock = null;
    try { fs.unlinkSync(SOCK); } catch {}
    return connectDaemon();
  }
  return h;
}

// ---------------------------------------------------------------- window
let win;
function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 820,
    minHeight: 520,
    title: 'Switchboard',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 19 },
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Automated test runs render off-screen and never take focus.
  if (process.env.SWITCHBOARD_SNAPSHOT) { win.setPosition(-6000, 0); win.once('ready-to-show', () => win.showInactive()); }
  else win.once('ready-to-show', () => win.show());
  win.on('focus', () => win.webContents.send('window:focus', true));
  win.on('blur', () => win.webContents.send('window:focus', false));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  // Dev aid: SWITCHBOARD_SNAPSHOT=/path/prefix runs SWITCHBOARD_STEPS (JS snippets), screenshots each, then quits.
  const snap = process.env.SWITCHBOARD_SNAPSHOT;
  if (snap) {
    win.webContents.on('console-message', (e) => console.log('[renderer]', e.level, e.message, e.lineNumber ?? ''));
    win.webContents.once('did-finish-load', async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      await wait(2000);
      const steps = JSON.parse(process.env.SWITCHBOARD_STEPS || '[]');
      for (let i = 0; i < steps.length; i++) {
        const [js, ms] = Array.isArray(steps[i]) ? steps[i] : [steps[i], 1500];
        try { const r = await win.webContents.executeJavaScript(js); if (r !== undefined) console.log(`step ${i}:`, JSON.stringify(r)); } catch (e) { console.error('step', i, e.message); }
        await wait(ms);
        fs.writeFileSync(`${snap}-${i}.png`, (await win.webContents.capturePage()).toPNG());
      }
      app.isQuitting = true;
      app.quit();
    });
  }
}

function buildMenu() {
  const send = (action, arg) => () => win && win.webContents.send('menu', action, arg);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Switchboard',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: send('settings') },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { label: 'Quit (Sessions Keep Running)', accelerator: 'CmdOrCtrl+Q', click: () => { app.isQuitting = true; app.quit(); } },
        { label: 'Quit and End All Sessions…', accelerator: 'CmdOrCtrl+Alt+Q', click: send('quit-all') },
      ],
    },
    {
      label: 'Shell',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: send('new-tab') },
        { label: 'New Claude Tab', accelerator: 'CmdOrCtrl+Shift+T', click: send('new-claude') },
        { type: 'separator' },
        { label: 'Split Right', accelerator: 'CmdOrCtrl+D', click: send('split', 'row') },
        { label: 'Split Down', accelerator: 'CmdOrCtrl+Shift+D', click: send('split', 'col') },
        { type: 'separator' },
        { label: 'Close Pane', accelerator: 'CmdOrCtrl+W', click: send('close-pane') },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+Shift+W', click: send('close-tab') },
        { type: 'separator' },
        { label: 'Clear Screen', accelerator: 'CmdOrCtrl+K', click: send('clear') },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: send('select-all') },
        { type: 'separator' },
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: send('find') },
      ],
    },
    {
      label: 'Go',
      submenu: [
        { label: 'Jump to Anything…', accelerator: 'CmdOrCtrl+P', click: send('palette') },
        { label: 'Next Session Waiting on You', accelerator: 'CmdOrCtrl+J', click: send('next-attention') },
        { type: 'separator' },
        { label: 'Office', accelerator: 'CmdOrCtrl+1', click: send('section', 'office') },
        { label: 'Personal', accelerator: 'CmdOrCtrl+2', click: send('section', 'personal') },
        { type: 'separator' },
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: send('cycle-tab', 1) },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: send('cycle-tab', -1) },
        { label: 'Next Tab', accelerator: 'CmdOrCtrl+Shift+]', click: send('cycle-tab', 1), visible: false },
        { label: 'Previous Tab', accelerator: 'CmdOrCtrl+Shift+[', click: send('cycle-tab', -1), visible: false },
        { type: 'separator' },
        { label: 'Focus Pane Left', accelerator: 'CmdOrCtrl+Alt+Left', click: send('focus-dir', 'left') },
        { label: 'Focus Pane Right', accelerator: 'CmdOrCtrl+Alt+Right', click: send('focus-dir', 'right') },
        { label: 'Focus Pane Up', accelerator: 'CmdOrCtrl+Alt+Up', click: send('focus-dir', 'up') },
        { label: 'Focus Pane Down', accelerator: 'CmdOrCtrl+Alt+Down', click: send('focus-dir', 'down') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: send('toggle-sidebar') },
        { type: 'separator' },
        { label: 'Bigger Text', accelerator: 'CmdOrCtrl+=', click: send('font', 1) },
        { label: 'Smaller Text', accelerator: 'CmdOrCtrl+-', click: send('font', -1) },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: send('font', 0) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
  ]));
}

// ---------------------------------------------------------------- hook state watcher
const hookSeen = new Map();
function readHookFile(file) {
  const paneId = path.basename(file, '.json');
  try {
    const st = fs.statSync(file);
    if (hookSeen.get(paneId) === st.mtimeMs) return;
    hookSeen.set(paneId, st.mtimeMs);
    const ev = JSON.parse(fs.readFileSync(file, 'utf8'));
    win?.webContents.send('claude:event', paneId, {
      event: ev.hook_event_name, session: ev.session_id, cwd: ev.cwd,
      message: ev.message, source: ev.source, at: st.mtimeMs,
    });
  } catch {}
}
function watchHooks() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.watch(STATE_DIR, (_t, name) => { if (name && name.endsWith('.json')) readHookFile(path.join(STATE_DIR, name)); });
}

// ---------------------------------------------------------------- IPC
ipcMain.handle('config:get', () => loadConfig());
ipcMain.on('config:save', (_e, cfg) => saveConfig(cfg));
ipcMain.handle('env', () => ({ home: HOME, version: app.getVersion(), hooks: hooksRegistered() }));
ipcMain.handle('daemon:hello', async () => { if (!sock) await connectDaemon(); return hello(); });
ipcMain.handle('uuid', () => crypto.randomUUID());

ipcMain.handle('pty:spawn', (_e, { id, cwd, cols, rows, section, command }) => {
  let dir = expand(cwd);
  if (!dir || !fs.existsSync(dir)) dir = HOME;
  const env = {
    ...daemonEnv(),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'Switchboard',
    TERM_PROGRAM_VERSION: app.getVersion(),
    SWITCHBOARD_PANE: id,
    SWITCHBOARD_SECTION: section,
    SWITCHBOARD_STATE_DIR: STATE_DIR,
  };
  return request({ t: 'spawn', id, cwd: dir, cols, rows, env, shell: process.env.SHELL || '/bin/zsh', command });
});
ipcMain.handle('pty:snapshot', (_e, id) => request({ t: 'snapshot', id }));
ipcMain.handle('pty:cwd', async (_e, id) => tildify((await request({ t: 'cwd', id })).cwd));
ipcMain.on('pty:procs-now', () => rawSend({ t: 'procs-now' }));
ipcMain.on('pty:write', (_e, id, d) => rawSend({ t: 'write', id, d }));
ipcMain.on('pty:resize', (_e, id, cols, rows) => rawSend({ t: 'resize', id, cols, rows }));
ipcMain.on('pty:kill', (_e, id) => {
  rawSend({ t: 'kill', id });
  try { fs.unlinkSync(path.join(STATE_DIR, id + '.json')); } catch {}
});
ipcMain.handle('claude:states', () => {
  try {
    for (const f of fs.readdirSync(STATE_DIR)) {
      if (!f.endsWith('.json')) continue;
      hookSeen.delete(path.basename(f, '.json'));
      readHookFile(path.join(STATE_DIR, f));
    }
  } catch {}
});
ipcMain.handle('quit-all', () => {
  rawSend({ t: 'shutdown' });
  app.isQuitting = true;
  setTimeout(() => app.quit(), 400);
});

ipcMain.handle('git', async (_e, paths) => {
  const out = {};
  await Promise.all(paths.map((p) => new Promise((resolve) => {
    execFile('git', ['-C', expand(p), 'status', '--porcelain=v2', '--branch', '-uno'], { timeout: 4000 }, (err, stdout) => {
      if (err) { out[p] = null; return resolve(); }
      const lines = stdout.split('\n');
      const head = lines.find((l) => l.startsWith('# branch.head '));
      const ab = lines.find((l) => l.startsWith('# branch.ab '));
      const m = ab && ab.match(/\+(\d+) -(\d+)/);
      out[p] = {
        branch: head ? head.slice(14) : null,
        dirty: lines.filter((l) => /^[12u] /.test(l)).length,
        ahead: m ? +m[1] : 0,
        behind: m ? +m[2] : 0,
      };
      resolve();
    });
  })));
  return out;
});

ipcMain.handle('dialog:folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: HOME });
  return r.canceled || !r.filePaths[0] ? null : tildify(r.filePaths[0]);
});
ipcMain.handle('menu:popup', (_e, items) => new Promise((resolve) => {
  let done = false;
  const finish = (v) => { if (!done) { done = true; resolve(v); } };
  const tpl = items.map((it) => (it === '-' ? { type: 'separator' } : {
    label: it.label, enabled: it.enabled !== false, click: () => finish(it.id),
  }));
  Menu.buildFromTemplate(tpl).popup({ window: win, callback: () => setTimeout(() => finish(null), 50) });
}));
ipcMain.on('reveal', (_e, p) => shell.openPath(expand(p)));
ipcMain.on('open-editor', (_e, p) => execFile('open', ['-a', 'Visual Studio Code', expand(p)]));
ipcMain.on('open-external', (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });
ipcMain.on('badge', (_e, n) => app.dock?.setBadge(n > 0 ? String(n) : ''));
ipcMain.on('notify', (_e, { title, body, paneId }) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body });
  n.on('click', () => { win?.show(); win?.focus(); win?.webContents.send('focus-pane', paneId); });
  n.show();
  if (!win?.isFocused()) app.dock?.bounce('informational');
});

// ---------------------------------------------------------------- lifecycle
app.setName('Switchboard');
app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  try { installHookScript(); } catch {}
  watchHooks();
  buildMenu();
  try { await connectDaemon(); } catch (e) { dialog.showErrorBox('Switchboard', e.message); }
  createWindow();
});
app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
app.on('before-quit', () => { app.isQuitting = true; });
app.on('window-all-closed', () => app.quit()); // shells live on in the daemon
