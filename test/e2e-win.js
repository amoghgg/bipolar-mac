// End-to-end check of the Windows build on a real Windows machine (CI or a PC).
// Usage: node test/e2e-win.js [path\to\Bipolar.exe]   (defaults to dist\Bipolar-win32-x64\Bipolar.exe)
// Runs the app twice in off-screen test mode against a throwaway config folder:
//   run 1 drives a PowerShell pane (prompt, folder tracking, argument quoting, fallbacks,
//   the Claude hook, Claude detection), run 2 checks the session survived the app quitting.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const exe = path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist', 'Bipolar-win32-x64', 'Bipolar.exe'));
const outRoot = process.env.BIPOLAR_E2E_DIR || os.tmpdir();
fs.mkdirSync(outRoot, { recursive: true });
const cfgDir = fs.mkdtempSync(path.join(outRoot, 'bipolar-e2e-'));
const results = [];
let failed = 0;
const check = (name, ok, detail) => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

// Shared helpers, defined in the page by the first step of each run.
const HELPERS = `(() => {
  window.T = {
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    pane: () => focusedPane(),
    screen: (n = 40) => { const p = focusedPane(); const b = p.term.buffer.active; const out = [];
      for (let y = 0; y < b.length; y++) out.push(b.getLine(y)?.translateToString(true) || '');
      return out.join('\\n').trim().split('\\n').slice(-n).join('\\n'); },
    run: (s) => sb.write(focusedPane().id, s + '\\r'),
    until: async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch {} await T.wait(250); } return false; },
  };
  return true;
})()`;

const step = (js, ms = 300) => [`(async () => { ${js} })()`, ms];

// Waits for the app process itself to exit (the session daemon it leaves running may hold
// inherited pipes open, so waiting for stdio to close would hang).
async function launch(name, steps) {
  const snap = path.join(cfgDir, name);
  const env = { ...process.env, SWITCHBOARD_CONFIG_DIR: cfgDir, SWITCHBOARD_SNAPSHOT: snap, SWITCHBOARD_STEPS: JSON.stringify([[HELPERS, 200], ...steps]) };
  const r = await new Promise((resolve) => {
    const child = spawn(exe, [], { env, stdio: 'ignore' });
    const t = setTimeout(() => { child.kill(); resolve({ error: 'timed out after 240s' }); }, 240000);
    child.on('exit', (code) => { clearTimeout(t); resolve({ code }); });
    child.on('error', (e) => { clearTimeout(t); resolve({ error: e.message }); });
  });
  const log = fs.existsSync(`${snap}-log.txt`) ? fs.readFileSync(`${snap}-log.txt`, 'utf8') : '';
  if (r.error) check(`${name}: app launched`, false, String(r.error));
  const out = {};
  for (const line of log.split('\n')) {
    const m = line.match(/^step (\d+)(?::| ERROR) (.*)$/);
    if (m) { try { out[+m[1] - 1] = JSON.parse(m[2]); } catch { out[+m[1] - 1] = { error: m[2] }; } }
  }
  console.log(`--- ${name} log ---\n${log}`);
  return out;
}

(async () => {
// ------------------------------------------------------------------ run 1
const HOOK = path.join(os.homedir(), '.config', 'switchboard', 'bin', 'sb-hook.ps1');
const r1 = await launch('run1', [
  step(`return { win: IS_WIN, portal: !document.getElementById('portal').hidden, locked: document.body.classList.contains('locked'), font: cfg.ui.font, newTask: document.querySelector('#new-task kbd').textContent };`),
  step(`await openTab(active, { name: 'Home', path: '~' });
        const ok = await T.until(() => /PS .*>/.test(T.screen()));
        await T.until(() => T.pane().proc, 8000);
        return { prompt: ok, proc: T.pane().proc, screen: T.screen(5) };`),
  step(`T.run('Set-Location $env:TEMP'); await T.wait(2500);
        return { cwd: await sb.cwd(T.pane().id) };`),
  step(`const args = ['fix the "login" bug', "it's here", 'C:\\\\Users\\\\a b\\\\x.png', 'plain'];
        T.run('node -e "console.log(\\'ARGV=\\'+JSON.stringify(process.argv.slice(1)))" ' + args.map(shq).join(' '));
        await T.until(() => /ARGV=\\[/.test(T.screen()));
        const line = T.screen().split('\\n').find((l) => l.startsWith('ARGV='));
        return { expected: args, got: line ? JSON.parse(line.slice(5)) : null };`),
  step(`T.run(orElse('cmd /c exit 3', 'Write-Output FALLBACK-RAN')); T.run(orElse('cmd /c exit 0', 'Write-Output SHOULD-NOT-RUN'));
        await T.wait(3000);
        const s = T.screen(30);
        return { fallback: /^FALLBACK-RAN/m.test(s), skipped: !/^SHOULD-NOT-RUN/m.test(s) };`),
  step(`T.run(${JSON.stringify(`'{"hook_event_name":"Stop","session_id":"e2e-session"}' | powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File '${HOOK}'`)});
        await T.until(() => T.pane().hook?.event === 'Stop', 15000);
        return { hook: T.pane().hook?.event || null, session: T.pane().claudeSession };`),
  step(`const r = await sb.registerHooks(); const e = await sb.env(); return { r, hooks: e.hooks };`),
  // Claude runs for 12s and is then stopped (its first-run setup screen may ignore Ctrl+C).
  step(`T.run('$c = Start-Process claude -NoNewWindow -PassThru; Start-Sleep 12; Stop-Process -Id $c.Id -Force; Write-Output CLAUDE-STOPPED');
        const ok = await T.until(() => T.pane().claudeRunning, 12000);
        const out = { detected: ok, proc: T.pane().proc, screen: T.screen(8) };
        await T.until(() => !T.pane().claudeRunning && /^CLAUDE-STOPPED/m.test(T.screen()), 25000);
        out.exitedBack = !T.pane().claudeRunning;
        return out;`),
  step(`const r = await sb.createProject({ parent: ${JSON.stringify(cfgDir.replace(/\\/g, '/'))}, name: 'my project', git: true });
        const bad = await sb.createProject({ parent: ${JSON.stringify(cfgDir.replace(/\\/g, '/'))}, name: 'a:b' });
        return { r, bad };`),
  step(`T.run('Write-Output BIPOLAR-MARK-4242'); await T.until(() => /^BIPOLAR-MARK-4242/m.test(T.screen()));
        persist(); await T.wait(800);
        return { id: T.pane().id, marked: /^BIPOLAR-MARK-4242/m.test(T.screen()) };`, 1500),
  // The first-launch offer to turn on precise status, answered with a real click.
  step(`const el = document.getElementById('confirm'); const shown = !el.hidden; const title = document.getElementById('confirm-title').textContent;
        el.querySelector('[data-yes]')?.click(); await T.wait(1500);
        return { shown, title, closed: el.hidden, hooks: (await sb.env()).hooks, offered: cfg.ui.hooksOffered };`),
]);

check('Windows mode detected', r1[0]?.win === true, r1[0]);
check('no lock screen', r1[0] && !r1[0].portal && !r1[0].locked, r1[0]);
check('Windows font + shortcut labels', r1[0]?.font === 'cascadia' && r1[0]?.newTask === 'Ctrl+Shift+N', r1[0]);
check('PowerShell prompt appears in a pane', r1[1]?.prompt === true, r1[1]);
check('idle shell reported as the shell (pwsh/powershell)', /^(pwsh|powershell)$/.test(r1[1]?.proc || ''), r1[1]);
check('folder tracking follows cd (splits open there)', (r1[2]?.cwd || '').toLowerCase().replace(/\\/g, '/').includes(path.basename(os.tmpdir()).toLowerCase()), r1[2]);
check('quoted arguments reach programs intact', JSON.stringify(r1[3]?.expected) === JSON.stringify(r1[3]?.got), r1[3]);
check('resume-or-start fallback works', r1[4]?.fallback && r1[4]?.skipped, r1[4]);
check('Claude hook script reports to the app', r1[5]?.hook === 'Stop' && r1[5]?.session === 'e2e-session', r1[5]);
check('"Turn on" registers hooks', r1[6]?.r?.ok && r1[6]?.hooks, r1[6]);
check('Claude detected when running', r1[7]?.detected === true, r1[7]);
check('Claude exit detected', r1[7]?.exitedBack === true, r1[7]);
check('add project creates folder', r1[8]?.r?.ok && fs.existsSync(path.join(cfgDir, 'my project', '.git')), r1[8]);
check('add project rejects bad names', r1[8]?.bad?.ok === false, r1[8]);
check('marker written before quit', r1[9]?.marked, r1[9]);
check('first launch offers precise status', r1[10]?.shown && /Claude is doing/.test(r1[10]?.title || ''), r1[10]);
check('clicking "Turn it on" works and is remembered', r1[10]?.closed && r1[10]?.hooks && r1[10]?.offered, r1[10]);

// Claude's settings got valid hooks in the documented exec form.
try {
  const st = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
  const h = st.hooks?.Stop?.find((x) => JSON.stringify(x).includes('sb-hook'))?.hooks?.[0];
  check('hook entry is exec-form powershell', h?.command === 'powershell.exe' && h.args.includes(HOOK) && h.async === true, h);
} catch (e) { check('settings.json readable', false, e.message); }

// ------------------------------------------------------------------ run 2: the session outlived the app
const r2 = await launch('run2', [
  step(`await T.wait(1500); const p = T.pane();
        return { id: p?.id, restored: /^BIPOLAR-MARK-4242/m.test(T.screen(60)) };`),
  step(`T.run('Write-Output STILL-ALIVE'); const ok = await T.until(() => /^STILL-ALIVE/m.test(T.screen()));
        return { alive: ok };`),
  step(`sb.quitAll(); return true;`, 1500),
]);
check('session survives quitting the app', r2[0]?.id && r2[0].id === r1[9]?.id, { before: r1[9], after: r2[0] });
check('screen restored on reopen', r2[0]?.restored, r2[0]);
check('restored shell still responds', r2[1]?.alive, r2[1]);

console.log('\n' + results.join('\n'));
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
})();
