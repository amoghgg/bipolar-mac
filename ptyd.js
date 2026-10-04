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

function spawn({ id, cwd, cols, rows, env, shell, command }) {
  if (panes.has(id)) return;
  const p = pty.spawn(shell || '/bin/zsh', ['-l'], {
    name: 'xterm-256color', cwd, cols, rows, env,
  });
  const head = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
  const ser = new SerializeAddon();
  head.loadAddon(ser);
  head.loadAddon(new Unicode11Addon());
  head.unicode.activeVersion = '11';
  const pane = { p, head, ser, meta: { id, cwd, pid: p.pid, started: Date.now() } };
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

// Foreground process per pane (e.g. "claude", "zsh", "npm"), pushed every 1.5s.
let lastProcs = '';
setInterval(() => {
  if (!clients.size) return;
  const procs = {};
  for (const [id, x] of panes) { try { procs[id] = x.p.process; } catch {} }
  const s = JSON.stringify(procs);
  if (s !== lastProcs) { lastProcs = s; broadcast({ t: 'procs', procs }); }
}, 1500);

let idleTimer;
function maybeExit() {
  clearTimeout(idleTimer);
  if (panes.size === 0 && clients.size === 0) idleTimer = setTimeout(() => process.exit(0), 15000);
}

try { fs.unlinkSync(SOCK); } catch {}
fs.mkdirSync(path.dirname(SOCK), { recursive: true });
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
server.listen(SOCK, () => fs.chmodSync(SOCK, 0o600));
process.on('SIGHUP', () => {});
process.on('uncaughtException', (e) => {
  try { fs.appendFileSync(path.join(path.dirname(SOCK), 'ptyd.log'), `${new Date().toISOString()} ${e.stack}\n`); } catch {}
});
maybeExit();
