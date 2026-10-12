// Switchboard session daemon.
// Owns every shell so they keep running when the app quits or crashes.
// Each pane is mirrored into a headless xterm so a reconnecting window gets
// the exact screen + scrollback back (VS Code's persistent-terminal approach).
//
// Run with ELECTRON_RUN_AS_NODE=1 <electron> ptyd.js <socketPath>
// Protocol: newline-delimited JSON over a unix socket.
const net = require('net');
const fs = require('fs');
const path = require('path');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { Unicode11Addon } = require('@xterm/addon-unicode11');

const IS_WIN = process.platform === 'win32';
const VERSION = 4;
const SOCK = process.argv[2];
const SCROLLBACK = 10000;
const panes = new Map(); // id -> { p, head, ser, meta }
const clients = new Set();

function send(sock, msg) {
  if (!sock.destroyed) sock.write(JSON.stringify(msg) + '\n');
}
function broadcast(msg) {
  const line = JSON.stringify(msg) + '\n';
  for (const c of clients) if (!c.destroyed) c.write(line);
}

function spawn({ id, cwd, cols, rows, env, shell, args, command }) {
  if (panes.has(id)) return;
  const p = pty.spawn(shell || (IS_WIN ? 'powershell.exe' : '/bin/zsh'), args || (IS_WIN ? [] : ['-l']), {
    name: 'xterm-256color', cwd, cols, rows, env,
    ...(IS_WIN ? { useConpty: true } : {}),
  });
  const head = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
  const ser = new SerializeAddon();
  head.loadAddon(ser);
  head.loadAddon(new Unicode11Addon());
  head.unicode.activeVersion = '11';
  const pane = { p, head, ser, cwd, meta: { id, cwd, pid: p.pid, started: Date.now() } };
  panes.set(id, pane);
  // Run the startup command only once the shell has drawn its prompt (output went
  // quiet), so it isn't echoed twice the way typing ahead of zsh would be.
  let pendingCmd = command || null;
  let cmdTimer;
  const fire = () => { if (pendingCmd) { p.write(pendingCmd + '\r'); pendingCmd = null; } };
  if (pendingCmd) setTimeout(fire, 8000); // safety net for very slow shells
  p.onData((d) => {
    if (pendingCmd) { clearTimeout(cmdTimer); cmdTimer = setTimeout(fire, 250); }
    head.write(d);
    if (IS_WIN && d.includes('\x1b]9;9;')) { // the PowerShell prompt reports its folder
      const m = d.match(/\x1b\]9;9;"?([^"\x07\x1b]*)"?(?:\x07|\x1b\\)/g);
      if (m) pane.cwd = m[m.length - 1].replace(/^\x1b\]9;9;"?/, '').replace(/"?(?:\x07|\x1b\\)$/, '');
    }
    broadcast({ t: 'data', id, d });
  });
  p.onExit(({ exitCode }) => {
    panes.delete(id);
    head.dispose();
    broadcast({ t: 'exit', id, code: exitCode });
    maybeExit();
  });
}

function handle(sock, msg) {
  const pane = msg.id && panes.get(msg.id);
  switch (msg.t) {
    case 'procs-now':
      lastProcs = '';
      break;
    case 'hello':
      send(sock, { t: 'hello', version: VERSION, pid: process.pid, panes: [...panes.values()].map((x) => x.meta) });
      break;
    case 'spawn':
      try { spawn(msg); send(sock, { t: 'spawned', id: msg.id, rid: msg.rid }); }
      catch (e) { send(sock, { t: 'spawned', id: msg.id, rid: msg.rid, error: String(e.message || e) }); }
      break;
    case 'snapshot':
      // Serialized synchronously, so nothing can slip between the snapshot and the live stream.
      send(sock, {
        t: 'snapshot', id: msg.id, rid: msg.rid,
        data: pane ? pane.ser.serialize({ scrollback: SCROLLBACK }) : null,
        cols: pane?.head.cols, rows: pane?.head.rows,
      });
      break;
    case 'write':
      pane?.p.write(msg.d);
      break;
    case 'resize':
      if (pane && msg.cols > 1 && msg.rows > 1) {
        try { pane.p.resize(msg.cols, msg.rows); pane.head.resize(msg.cols, msg.rows); } catch {}
      }
      break;
    case 'kill':
      pane?.p.kill();
      break;
    case 'cwd':
      if (IS_WIN) { send(sock, { t: 'cwd', id: msg.id, rid: msg.rid, cwd: pane?.cwd || null }); break; }
      // Resolve the shell's current directory (best effort, macOS lsof).
      require('child_process').execFile('lsof', ['-a', '-p', String(pane?.p.pid || 0), '-d', 'cwd', '-Fn'], (err, out) => {
        const line = (out || '').split('\n').find((l) => l.startsWith('n'));
        send(sock, { t: 'cwd', id: msg.id, rid: msg.rid, cwd: line ? line.slice(1) : null });
      });
      break;
    case 'shutdown':
      for (const x of panes.values()) x.p.kill();
      setTimeout(() => process.exit(0), 300);
      break;
  }
}

// Windows: node-pty only knows the shell's own name, so one long-lived PowerShell lists the
// process table every 1.5s and each pane reports what runs under its shell.
let procTable = null; // pid -> { ppid, name, cmd }
function watchWinProcs() {
  const script = "$ErrorActionPreference='SilentlyContinue'; while ($true) { Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine | ForEach-Object { $c = ''; if ($_.Name -match '^(node|bun)') { $c = $_.CommandLine }; \"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)`t$c\" }; '--'; Start-Sleep -Milliseconds 1500 }";
  const ps = require('child_process').spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let buf = '', rows = new Map();
  ps.stdout.setEncoding('utf8');
  ps.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line === '--') { procTable = rows; rows = new Map(); continue; }
      const [pid, ppid, name, cmd] = line.split('\t');
      if (pid) rows.set(+pid, { ppid: +ppid, name: (name || '').replace(/\.exe$/i, '').toLowerCase(), cmd: cmd || '' });
    }
  });
  ps.on('exit', () => setTimeout(watchWinProcs, 3000));
}
const HELPERS = /^(conhost|openconsole|winpty-agent)$/;
function winForeground(shellPid, shellName) {
  if (!procTable) return shellName;
  const kids = new Map();
  for (const [pid, r] of procTable) { if (!kids.has(r.ppid)) kids.set(r.ppid, []); kids.get(r.ppid).push(pid); }
  let first = null;
  const walk = (pid, depth) => {
    for (const k of kids.get(pid) || []) {
      const r = procTable.get(k);
      if (!r || HELPERS.test(r.name)) continue;
      if (r.name === 'claude' || /claude-code|@anthropic-ai/i.test(r.cmd)) return 'claude';
      if (!first && depth === 0) first = r.name;
      const deep = depth < 6 && walk(k, depth + 1);
      if (deep) return deep;
    }
    return null;
  };
  return walk(shellPid, 0) || first || shellName;
}
if (IS_WIN) watchWinProcs();

// Foreground process per pane (e.g. "claude", "zsh", "npm"), pushed every 1.5s.
let lastProcs = '';
setInterval(() => {
  if (!clients.size) return;
  const procs = {};
  for (const [id, x] of panes) {
    try {
      procs[id] = IS_WIN ? winForeground(x.p.pid, path.basename(String(x.p.process || 'powershell')).replace(/\.exe$/i, '').toLowerCase()) : x.p.process;
    } catch {}
  }
  const s = JSON.stringify(procs);
  if (s !== lastProcs) { lastProcs = s; broadcast({ t: 'procs', procs }); }
}, 1500);

let idleTimer;
function maybeExit() {
  clearTimeout(idleTimer);
  if (panes.size === 0 && clients.size === 0) idleTimer = setTimeout(() => process.exit(0), 15000);
}

if (!IS_WIN) {
  try { fs.unlinkSync(SOCK); } catch {}
  fs.mkdirSync(path.dirname(SOCK), { recursive: true });
}
const server = net.createServer((sock) => {
  clients.add(sock);
  clearTimeout(idleTimer);
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line) try { handle(sock, JSON.parse(line)); } catch {}
    }
  });
  const drop = () => { clients.delete(sock); maybeExit(); };
  sock.on('close', drop);
  sock.on('error', drop);
});
server.listen(SOCK, () => { if (!IS_WIN) fs.chmodSync(SOCK, 0o600); });
process.on('SIGHUP', () => {});
process.on('uncaughtException', (e) => {
  const dir = IS_WIN ? path.join(require('os').homedir(), '.config', 'switchboard') : path.dirname(SOCK);
  try { fs.appendFileSync(path.join(dir, 'ptyd.log'), `${new Date().toISOString()} ${e.stack}\n`); } catch {}
});
maybeExit();
