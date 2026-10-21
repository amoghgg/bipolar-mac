// Agent feed: turns a Claude Code session transcript (~/.claude/projects/*/<session>.jsonl)
// into what the Agents deck shows — the task, the steps with their status, the agent's
// checklist, its latest words and the files it produced. Read-only; reads only new bytes
// on each poll, so following a live session costs almost nothing.
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const PROJECTS = path.join(HOME, '.claude', 'projects');
const OUTPUT_EXT = /\.(xlsx|xlsm|xls|csv|pdf|html?|png|jpe?g|webp|gif|svg|docx|pptx|zip|json|md|txt|apk|mp4|mov|py|tex)$/i;
const MAX_FIRST_READ = 6 * 1024 * 1024; // a huge old transcript: start from its tail

const cache = new Map(); // session -> state
const home = (p) => (p && p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p);
const base = (p) => (p ? path.basename(p) : '');
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

function findTranscript(session) {
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS); } catch { return null; }
  for (const d of dirs) {
    const f = path.join(PROJECTS, d, session + '.jsonl');
    if (fs.existsSync(f)) return f;
  }
  return null;
}

// One line per tool call, in plain words.
function describe(name, input = {}) {
  const f = input.file_path || input.notebook_path || input.path;
  switch (name) {
    case 'Read': return { verb: 'Read', what: base(f), kind: 'read' };
    case 'Write': return { verb: 'Wrote', what: base(f), kind: 'write', file: f };
    case 'Edit': case 'MultiEdit': return { verb: 'Edited', what: base(f), kind: 'write', file: f };
    case 'NotebookEdit': return { verb: 'Edited', what: base(f), kind: 'write', file: f };
    case 'Bash': return { verb: 'Ran', what: clip(input.description || input.command, 80), kind: 'run', detail: clip(input.command, 240) };
    case 'Glob': return { verb: 'Looked for', what: clip(input.pattern, 60), kind: 'search' };
    case 'Grep': return { verb: 'Searched for', what: clip(input.pattern, 60), kind: 'search' };
    case 'WebFetch': { let h = input.url; try { h = new URL(input.url).host; } catch {} return { verb: 'Read the web', what: h, kind: 'web' }; }
    case 'WebSearch': return { verb: 'Searched the web', what: clip(input.query, 70), kind: 'web' };
    case 'Agent': case 'Task': return { verb: 'Handed off', what: clip(input.description || input.prompt, 70), kind: 'agent' };
    case 'TodoWrite': return null; // shown as the checklist instead
    case 'AskUserQuestion': return { verb: 'Asked you', what: clip(input.questions?.[0]?.question, 80), kind: 'ask' };
    case 'Skill': return { verb: 'Used skill', what: input.skill, kind: 'agent' };
    case 'ToolSearch': return null;
    default: {
      const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
      return m ? { verb: m[2].replace(/[-_]/g, ' '), what: m[1].replace(/^claude_ai_/, ''), kind: 'tool' } : { verb: name, what: '', kind: 'tool' };
    }
  }
}

function fresh(file) {
  return { file, offset: 0, partial: '', task: '', startedAt: 0, updatedAt: 0, steps: [], byId: new Map(),
    todos: null, lastText: '', textAt: 0, files: new Map(), counts: { steps: 0, errors: 0 }, turns: 0 };
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
  return '';
}

function ingest(st, d) {
  if (d.isSidechain || d.isMeta) return;
  const ts = d.timestamp ? Date.parse(d.timestamp) : 0;
  const content = d.message?.content;
  if (d.type === 'user') {
    if (Array.isArray(content) && content.some((x) => x.type === 'tool_result')) {
      for (const r of content.filter((x) => x.type === 'tool_result')) {
        const s = st.byId.get(r.tool_use_id);
        if (!s) continue;
        s.status = r.is_error ? 'error' : 'done';
        s.endedAt = ts;
        if (!r.is_error && s.kind === 'run') {
          for (const m of textOf(r.content).matchAll(/^(?:board|saved|wrote|written|created|output|exported|copied)\b[^\n]*?((?:~|\/Users\/[^/\s]+)\/[^\s`'"()<>|*]+)/gim)) {
            const p = m[1].replace(/[.,;:]+$/, '');
            if (OUTPUT_EXT.test(p)) st.files.set(p.startsWith('~') ? path.join(HOME, p.slice(1)) : p, ts);
          }
        }
        if (r.is_error) { st.counts.errors++; s.note = clip(textOf(r.content), 160); }
      }
    } else {
      const t = textOf(content).trim();
      if (t && !t.startsWith('<') && !/^\[Request interrupted/.test(t)) {
        if (!st.task) st.task = clip(t, 220);
        st.turns++;
        st.steps.push({ id: 'u' + st.steps.length, kind: 'you', verb: 'You', what: clip(t, 160), status: 'done', at: ts });
      }
    }
  } else if (d.type === 'assistant' && Array.isArray(content)) {
    for (const it of content) {
      if (it.type === 'text' && it.text?.trim()) { st.lastText = it.text.trim(); st.textAt = ts; }
      if (it.type !== 'tool_use') continue;
      if (it.name === 'TodoWrite' && Array.isArray(it.input?.todos)) {
        st.todos = it.input.todos.map((x) => ({ text: x.status === 'in_progress' && x.activeForm ? x.activeForm : x.content, status: x.status }));
        continue;
      }
      const desc = describe(it.name, it.input);
      if (!desc) continue;
      const step = { id: it.id, ...desc, status: 'running', at: ts };
      st.byId.set(it.id, step);
      st.steps.push(step);
      st.counts.steps++;
      if (desc.file) st.files.set(desc.file, ts);
    }
    // Files the agent names in its own words ("saved to ~/OTR/…/v4.xlsx")
    for (const it of content) {
      if (it.type !== 'text') continue;
      for (const m of it.text.matchAll(/(?:~|\/Users\/[^/\s]+)\/[^\s`'"()<>|*]+/g)) {
        const p = m[0].replace(/[.,;:]+$/, '');
        if (OUTPUT_EXT.test(p)) st.files.set(p.startsWith('~') ? path.join(HOME, p.slice(1)) : p, ts);
      }
    }
  }
  if (ts) { st.updatedAt = Math.max(st.updatedAt, ts); if (!st.startedAt) st.startedAt = ts; }
}

function read(session) {
  let st = cache.get(session);
  if (!st || !fs.existsSync(st.file)) {
    const file = findTranscript(session);
    if (!file) return null;
    st = fresh(file);
    cache.set(session, st);
  }
  let size;
  try { size = fs.statSync(st.file).size; } catch { return st; }
  if (size < st.offset) { const f = st.file; st = fresh(f); cache.set(session, st); } // rewritten
  if (size > st.offset) {
    let start = st.offset;
    if (start === 0 && size > MAX_FIRST_READ) start = size - MAX_FIRST_READ;
    const fd = fs.openSync(st.file, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const chunk = st.partial + buf.toString('utf8');
    const lines = chunk.split('\n');
    st.partial = lines.pop();
    if (start > 0 && st.offset === 0) lines.shift(); // first line of a tail read is cut
    for (const line of lines) {
      if (!line || (!line.includes('"type":"user"') && !line.includes('"type":"assistant"'))) continue;
      try { ingest(st, JSON.parse(line)); } catch {}
    }
    st.offset = size;
  }
  return st;
}

function feed(session) {
  const st = read(session);
  if (!st) return { found: false };
  const files = [...st.files.entries()]
    .map(([p, at]) => { let s = null; try { s = fs.statSync(p); } catch {} return s && s.isFile() ? { path: home(p), abs: p, name: /\/DesignReviews\//.test(p) && base(p) === 'index.html' ? 'Review board · ' + base(path.dirname(path.dirname(p))) : base(p), board: /\/DesignReviews\/.+\/index\.html$/.test(p), ext: path.extname(p).slice(1).toLowerCase(), bytes: s.size, at: Math.max(at, s.mtimeMs) } : null; })
    .filter(Boolean).sort((a, b) => b.at - a.at).slice(0, 24);
  return {
    found: true, transcript: home(st.file), task: st.task, startedAt: st.startedAt, updatedAt: st.updatedAt,
    steps: st.steps.slice(-60).map(({ file, ...s }) => s), todos: st.todos, lastText: st.lastText.slice(0, 4000), textAt: st.textAt,
    files, counts: { ...st.counts, files: files.length, turns: st.turns },
  };
}

// The last run of each agent, for the Agents home screen.
function summary(session) {
  const f = feed(session);
  return f.found ? { task: f.task, startedAt: f.startedAt, updatedAt: f.updatedAt, files: f.files.slice(0, 3), counts: f.counts, lastText: clip(f.lastText, 180) } : null;
}

module.exports = { feed, summary };
