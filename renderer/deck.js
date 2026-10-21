// ============================================================================
// Agent deck — what an agent session looks like instead of a wall of terminal.
// The real Claude session keeps running in the terminal underneath (permissions,
// /commands, resume all unchanged); the deck reads its transcript and draws it:
// the task, a live thread of steps, the agent's checklist and latest words, the
// files it made, and its questions as buttons. One click flips to the terminal.
// Also: the Agents home screen (every agent, its last run, one-click starters).
// ============================================================================
const Deck = (() => {
  const decks = new Map(); // tabId -> { el, html: {region: string}, feed }
  let homeEl = null;
  let summaries = {};
  let homeSel = 0;

  const G = { // small line glyphs, one per kind of step
    read: '<svg viewBox="0 0 16 16"><path d="M3.5 2.5h6l3 3v8h-9z M9.5 2.5v3h3"/></svg>',
    write: '<svg viewBox="0 0 16 16"><path d="M3 13l.6-2.6 7.2-7.2 2 2-7.2 7.2z M9.6 4.4l2 2"/></svg>',
    run: '<svg viewBox="0 0 16 16"><path d="M3 4.5l3.5 3.5L3 11.5 M8 12h5"/></svg>',
    search: '<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/></svg>',
    web: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11 M8 2.5c2 2 2 9 0 11 M8 2.5c-2 2-2 9 0 11"/></svg>',
    agent: '<svg viewBox="0 0 16 16"><path d="M8 2v3 M8 11v3 M2 8h3 M11 8h3 M4 4l2 2 M10 10l2 2 M12 4l-2 2 M6 10l-2 2"/></svg>',
    ask: '<svg viewBox="0 0 16 16"><path d="M6 6a2 2 0 1 1 3 1.7c-.6.4-1 .8-1 1.6 M8 11.5v.5"/></svg>',
    tool: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="2"/></svg>',
    you: '<svg viewBox="0 0 16 16"><path d="M3 4h10v6H8l-3 2.5V10H3z"/></svg>',
    term: '<svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="2"/><path d="M5 7l2 1.5L5 10 M8.5 10.5H11"/></svg>',
    deck: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="2"/></svg>',
    open: '<svg viewBox="0 0 16 16"><path d="M9 3h4v4 M13 3L7.5 8.5 M11 9.5V13H3V5h3.5"/></svg>',
    send: '<svg viewBox="0 0 16 16"><path d="M3 8h9 M8.5 4.5L12 8l-3.5 3.5"/></svg>',
    stop: '<svg viewBox="0 0 16 16"><rect x="4.5" y="4.5" width="7" height="7" rx="1.2"/></svg>',
  };
  const IMG = /^(png|jpe?g|webp|gif|svg)$/i, HTML = /^html?$/i;
  const visual = (x) => IMG.test(x.ext) || HTML.test(x.ext);
  const fileUrl = (x) => 'file://' + encodeURI(x.abs || '') + '?v=' + Math.round(x.at || 0);
  const fmtBytes = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? Math.round(n / 1024) + ' KB' : n + ' B');
  const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(s % 60).padStart(2, '0')}s`; };
  const since = (ts) => (ts ? ago(ts) : '');
  const agentPane = (tab) => leaves(tab.root).map((id) => panes.get(id)).find((p) => p && p.agent);
  const isAgentTab = (tab) => !!(tab && agentPane(tab));
  const on = (tab) => isAgentTab(tab) && !tab.term;

  // Light markdown for the agent's own words: paragraphs, bullets, **bold**, `code`, headings.
  function md(text) {
    const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    const out = [];
    let list = null;
    for (const raw of text.split('\n')) {
      const line = raw.trimEnd();
      const li = /^\s*(?:[-*•]|\d+\.)\s+(.*)$/.exec(line);
      if (li) { if (!list) { list = []; out.push(list); } list.push(inline(li[1])); continue; }
      list = null;
      if (!line.trim()) continue;
      const h = /^#{1,4}\s+(.*)$/.exec(line);
      if (h) out.push(`<h4>${inline(h[1])}</h4>`);
      else if (/^\|.*\|$/.test(line)) out.push(`<p class="tbl">${inline(line)}</p>`);
      else if (/^```/.test(line)) continue;
      else out.push(`<p>${inline(line)}</p>`);
    }
    return out.map((x) => (Array.isArray(x) ? `<ul>${x.map((i) => `<li>${i}</li>`).join('')}</ul>` : x)).join('');
  }

  // The question Claude is showing (permission, trust, a choice) with its numbered options.
  function question(p) {
    if (!p || p.state !== 'waiting') return null;
    // Claude's menus: the highlighted option carries ❯; its siblings are the lines around it
    // (numbered "1. Yes" in some prompts, plain "Yes, I trust this folder" in others).
    const lines = screenText(p, 40).split('\n').map((l) => l.replace(/^\s*│/, '').replace(/│\s*$/, '').replace(/\s+$/, ''));
    const cur = lines.map((l, i) => (/^\s*❯\s+\S/.test(l) ? i : -1)).filter((i) => i >= 0).pop();
    let opts = [], sel = 0, top = cur;
    if (cur !== undefined) {
      const isOpt = (l) => l.trim() && !/^(Enter to|Esc to|\(esc\))/i.test(l.trim()) && !/[?:]$/.test(l.trim()) && !/^[─━-]{4,}/.test(l.trim());
      while (top > 0 && isOpt(lines[top - 1]) && /^\s*(\d+\.\s|\S)/.test(lines[top - 1]) && lines[top - 1].search(/\S/) >= lines[cur].search(/\S/)) top--;
      let end = cur;
      while (end + 1 < lines.length && isOpt(lines[end + 1])) end++;
      for (let i = top; i <= end; i++) {
        const label = lines[i].trim().replace(/^❯\s*/, '').replace(/^\d+\.\s+/, '');
        if (i === cur) sel = opts.length;
        opts.push({ n: opts.length + 1, label });
      }
      if (opts.length > 9) { opts = []; sel = 0; }
    }
    // The question's own paragraph: the nearest paragraph above the options that asks something.
    const paras = [];
    let para = [];
    for (const l of lines.slice(0, top ?? lines.length)) {
      const t = l.trim();
      if (!t || /^[─━╭╰-]{4,}/.test(t)) { if (para.length) paras.push(para.join(' ')); para = []; } else para.push(t);
    }
    if (para.length) paras.push(para.join(' '));
    const useful = paras.filter((x) => !/^Security guide$/i.test(x));
    const qline = [...useful].reverse().find((x) => /\?/.test(x)) || useful.slice(-1)[0] || '';
    return { text: p.message || qline || 'Waiting for your answer', detail: qline.length > 220 ? qline.slice(0, 219) + '…' : qline, opts, sel };
  }

  function answer(p, q, idx) {
    if (!q.opts.length) return;
    const d = idx - q.sel;
    const key = d > 0 ? '\x1b[B' : '\x1b[A';
    sb.write(p.id, key.repeat(Math.abs(d)) + '\r');
  }

  // ------------------------------------------------------------ the deck
  function build(tab) {
    const el = document.createElement('section');
    el.className = 'deck';
    el.dataset.tab = tab.id;
    el.innerHTML = `
      <div class="deck-grid" aria-hidden="true"></div>
      <header class="deck-head">
        <div class="deck-orb"><i></i><b></b></div>
        <div class="deck-id"><div class="deck-who"></div><h2 class="deck-task"></h2></div>
        <div class="deck-meta"></div>
        <button class="deck-flip" title="Show the terminal underneath">${G.term}<span>terminal</span></button>
      </header>
      <div class="deck-body">
        <div class="deck-thread"><div class="deck-label">thread</div><ol class="thread"></ol></div>
        <div class="deck-side">
          <div class="deck-board"></div>
          <div class="deck-now"></div>
          <div class="deck-todos"></div>
          <div class="deck-files"></div>
        </div>
      </div>
      <footer class="deck-cmd">
        <div class="cmd-box"><span class="cmd-at"></span><textarea rows="1" spellcheck="false"></textarea>
        <button class="cmd-stop" title="Interrupt (esc)">${G.stop}</button><button class="cmd-send" title="Send (↵)">${G.send}</button></div>
        <div class="cmd-hint"></div>
      </footer>
      <div class="deck-viewer" hidden>
        <header><div class="v-title"><b></b><span></span></div>
          <div class="v-acts"><button data-v="prev" title="Previous (←)">‹</button><button data-v="next" title="Next (→)">›</button>
          <button data-v="browser">open in browser</button><button data-v="finder">show in Finder</button><button data-v="close" title="Close (esc)">close</button></div></header>
        <div class="v-stage"></div>
      </div>`;
    const ta = $('textarea', el);
    const send = () => {
      const p = agentPane(tab); const v = ta.value.trim();
      if (!p || !v) return;
      sb.write(p.id, v.replace(/\n/g, ' ') + '\r');
      ta.value = ''; ta.style.height = '';
      toast(`Sent to ${p.agent}`);
    };
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
      if (e.key === 'Escape') { const p = agentPane(tab); if (p && p.state === 'working') sb.write(p.id, '\x1b'); }
    });
    ta.addEventListener('input', () => { ta.style.height = ''; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; });
    $('.cmd-send', el).addEventListener('click', send);
    $('.cmd-stop', el).addEventListener('click', () => { const p = agentPane(tab); if (p) sb.write(p.id, '\x1b'); });
    $('.deck-flip', el).addEventListener('click', () => flip(tab, true));
    el.addEventListener('click', (e) => {
      const v = e.target.closest('[data-v]')?.dataset.v;
      if (v) return viewerAct(tab, v);
      const f = e.target.closest('[data-file]');
      if (f) {
        if (e.altKey || e.target.closest('.show')) return sb.showFile(f.dataset.file);
        const d = decks.get(tab.id); const x = d?.feed?.files.find((y) => y.path === f.dataset.file);
        if (x && visual(x) && !e.target.closest('.ext-open')) return openViewer(tab, x.path);
        return sb.openFile(f.dataset.file);
      }
      const o = e.target.closest('[data-opt]');
      if (o) { const p = agentPane(tab); const q = question(p); if (q) answer(p, q, +o.dataset.opt); return; }
      if (e.target.closest('[data-esc]')) { const p = agentPane(tab); if (p) sb.write(p.id, '\x1b'); }
    });
    return { el, html: {}, feed: null };
  }

  function attach(tab, view) {
    if (!isAgentTab(tab)) return;
    let d = decks.get(tab.id);
    if (!d) { d = build(tab); decks.set(tab.id, d); }
    view.appendChild(d.el);
    let pill = $('.deck-pill', view);
    if (!pill) {
      pill = document.createElement('button');
      pill.className = 'deck-pill';
      pill.innerHTML = `${G.deck}<span>agent view</span>`;
      pill.addEventListener('click', () => flip(tab, false));
      view.appendChild(pill);
    }
    view.classList.toggle('has-deck', on(tab));
    paint(tab);
  }

  function flip(tab, toTerminal) {
    tab.term = toTerminal || undefined;
    const view = $(`.view[data-tab="${tab.id}"]`);
    view?.classList.toggle('has-deck', on(tab));
    persist();
    if (toTerminal) requestAnimationFrame(() => { refit(tab); focusPane(tab.focus); });
    else { paint(tab); focus(tab); }
  }

  function focus(tab) {
    if (!on(tab)) return false;
    const ta = $('textarea', decks.get(tab.id)?.el || document.createElement('div'));
    if (ta && !editingName) ta.focus();
    return true;
  }

  const set = (d, region, html) => {
    if (d.html[region] === html) return;
    d.html[region] = html;
    const target = $(region, d.el);
    if (target) target.innerHTML = html;
  };

  function paint(tab) {
    const d = decks.get(tab.id);
    if (!d || !on(tab)) return;
    const p = agentPane(tab);
    const f = d.feed || { steps: [], files: [], counts: {} };
    const st = sessState(p);
    const q = question(p);
    d.el.dataset.state = q ? 'waiting' : st;
    const a = (typeof agentList !== 'undefined' ? agentList : []).find((x) => x.name === p.agent);

    set(d, '.deck-who', `<span class="who-name">${esc(p.agent)}</span><span class="dot">·</span><span>${esc(p.path)}</span>${a?.tag ? `<span class="dot">·</span><span class="who-tag">${esc(a.tag)}</span>` : ''}`);
    set(d, '.deck-task', esc(f.task || (st === 'shell' ? 'Session ended' : 'Ready when you are')));
    const label = { working: 'working', waiting: 'needs you', idle: 'ready', done: 'finished', shell: 'stopped', moving: 'moving in' }[q ? 'waiting' : st] || st;
    const elapsed = f.startedAt ? clock((st === 'working' ? Date.now() : f.updatedAt || Date.now()) - f.startedAt) : '';
    set(d, '.deck-meta', `<span class="m-state">${label}</span>${elapsed ? `<span><b>${elapsed}</b></span>` : ''}${typeof ctxOf === 'function' && ctxOf(tab) ? `<span class="m-ctx ${ctxLevel(ctxOf(tab))}" title="Context re-read on every step"><b>${ctxLabel(ctxOf(tab))}</b> context</span>` : ''}<span><b>${f.counts.steps || 0}</b> steps</span><span><b>${f.files.length}</b> files</span>${f.counts.errors ? `<span class="m-err"><b>${f.counts.errors}</b> retried</span>` : ''}`);

    // thread
    const steps = f.steps.slice(-40);
    const thread = steps.map((s, i) => {
      const last = i === steps.length - 1;
      const status = s.status === 'running' && !last && st !== 'working' ? 'done' : s.status;
      if (s.kind === 'you') return `<li class="you"><i class="node">${G.you}</i><div><q>${esc(s.what)}</q><time>${since(s.at)}</time></div></li>`;
      return `<li class="${s.kind} ${status}"><i class="node">${G[s.kind] || G.tool}</i><div><span class="verb">${esc(s.verb)}</span> <span class="what">${esc(s.what)}</span><time>${status === 'running' ? 'now' : since(s.at)}</time>${s.note ? `<small>${esc(s.note)}</small>` : ''}</div></li>`;
    }).join('') || `<li class="empty"><div>Steps appear here as ${esc(p.agent)} works.</div></li>`;
    if (d.html['.thread'] !== thread) {
      const ol = $('.thread', d.el);
      const stick = ol.parentElement.scrollHeight - ol.parentElement.scrollTop - ol.parentElement.clientHeight < 60;
      set(d, '.thread', thread);
      if (stick) ol.parentElement.scrollTop = ol.parentElement.scrollHeight;
    }

    // now: a question, or the agent's latest words
    let now;
    if (q) {
      now = `<div class="ask"><div class="deck-label">needs you</div><p class="ask-q">${esc(q.text)}</p>${q.detail && q.detail !== q.text ? `<p class="ask-d">${esc(q.detail)}</p>` : ''}
        <div class="ask-opts">${q.opts.map((o, i) => `<button data-opt="${i}" class="${i === q.sel ? 'sel' : ''}"><kbd>${o.n}</kbd>${esc(o.label)}</button>`).join('')}
        <button data-esc class="ghost">Cancel <kbd>esc</kbd></button></div>
        ${q.opts.length ? '' : '<p class="ask-d">Reply below, or open the terminal.</p>'}</div>`;
    } else if (f.lastText) {
      now = `<div class="said"><div class="deck-label">${esc(p.agent)} says <time>${since(f.textAt)}</time></div><div class="md">${md(f.lastText)}</div></div>`;
    } else now = `<div class="said quiet"><div class="deck-label">${esc(p.agent)}</div><p>${st === 'working' ? 'Thinking…' : 'Tell it what you need below. It already knows its job.'}</p></div>`;
    set(d, '.deck-now', now);

    // checklist
    const todos = f.todos || [];
    const doneN = todos.filter((t) => t.status === 'completed').length;
    set(d, '.deck-todos', todos.length ? `<div class="deck-label">plan <span>${doneN}/${todos.length}</span></div>
      <div class="bar"><i style="width:${(doneN / todos.length) * 100}%"></i></div>
      <ul>${todos.map((t) => `<li class="${t.status}">${esc(t.text)}</li>`).join('')}</ul>` : '');

    // the latest review board, live
    const board = f.files.find((x) => x.board);
    set(d, '.deck-board', board ? `<div class="deck-label">review board <time>${new Date(board.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>
      <button class="board-card" data-file="${esc(board.path)}" title="Open the review board">
        <span class="board-frame"><iframe src="${esc(fileUrl(board))}" sandbox="allow-scripts" tabindex="-1" loading="lazy"></iframe></span>
        <span class="board-cta">open board ${G.open}</span></button>` : '');
    if (board) {
      d.seenBoards = d.seenBoards || new Set();
      if (!d.boardsPrimed) { d.boardsPrimed = true; f.files.filter((x) => x.board).forEach((x) => d.seenBoards.add(x.path + x.at)); }
      else if (!d.seenBoards.has(board.path + board.at)) { d.seenBoards.add(board.path + board.at); if (currentTab() === tab && st !== 'working') openViewer(tab, board.path); }
    }

    // files
    set(d, '.deck-files', f.files.length ? `<div class="deck-label">made <span>${f.files.length}</span></div><div class="tiles">${f.files.slice(0, 12).map((x) => `
      <button class="tile ${IMG.test(x.ext) ? 'has-thumb' : ''}" data-file="${esc(x.path)}" title="${esc(x.path)} — click to ${visual(x) ? 'preview' : 'open'}, ⌥-click to show in Finder">
        ${IMG.test(x.ext) ? `<span class="thumb"><img src="${esc(fileUrl(x))}" loading="lazy" alt=""></span>` : ''}
        <span class="ext ${esc(x.ext)}">${esc(x.board ? 'board' : x.ext || 'file')}</span><span class="fname">${esc(x.name)}</span>
        <span class="fmeta">${fmtBytes(x.bytes)} · ${since(x.at)}${visual(x) ? ' · preview' : ''}</span><span class="show" title="Show in Finder">${G.open}</span></button>`).join('')}</div>` : '');

    // command bar
    set(d, '.cmd-at', `@${esc(p.agent)}`);
    $('textarea', d.el).placeholder = q ? 'Or type an answer…' : st === 'working' ? `Add to what ${p.agent} is doing…` : `Tell ${p.agent} what you need`;
    set(d, '.cmd-hint', st === 'working' ? '↵ send · esc interrupts' : '↵ send · ⇧↵ new line');
    d.el.classList.toggle('working', st === 'working' && !q);
  }

  // ------------------------------------------------------------ the viewer
  function openViewer(tab, filePath) {
    const d = decks.get(tab.id);
    if (!d?.feed) return;
    d.vList = d.feed.files.filter(visual);
    d.vIdx = Math.max(0, d.vList.findIndex((x) => x.path === filePath));
    showViewer(d);
  }
  function showViewer(d) {
    const x = d.vList[d.vIdx];
    const v = $('.deck-viewer', d.el);
    if (!x) { v.hidden = true; return; }
    $('.v-title b', v).textContent = x.name;
    $('.v-title span', v).textContent = `${x.path} · ${d.vIdx + 1} of ${d.vList.length}`;
    $('.v-stage', v).innerHTML = IMG.test(x.ext)
      ? `<img src="${esc(fileUrl(x))}" alt="">`
      : `<iframe src="${esc(fileUrl(x))}" sandbox="allow-scripts allow-popups"></iframe>`;
    v.hidden = false;
    d.el.classList.add('viewing');
  }
  function viewerAct(tab, act) {
    const d = decks.get(tab.id);
    if (!d?.vList) return;
    const x = d.vList[d.vIdx];
    if (act === 'close') { $('.deck-viewer', d.el).hidden = true; $('.v-stage', d.el).innerHTML = ''; d.el.classList.remove('viewing'); focus(tab); }
    else if (act === 'prev' || act === 'next') { d.vIdx = (d.vIdx + (act === 'next' ? 1 : -1) + d.vList.length) % d.vList.length; showViewer(d); }
    else if (act === 'browser' && x) sb.openFile(x.path);
    else if (act === 'finder' && x) sb.showFile(x.path);
  }
  document.addEventListener('keydown', (e) => {
    const tab = currentTab();
    const d = tab && decks.get(tab.id);
    if (!d || !d.el.classList.contains('viewing')) return;
    const act = { Escape: 'close', ArrowLeft: 'prev', ArrowRight: 'next' }[e.key];
    if (act) { e.preventDefault(); e.stopPropagation(); viewerAct(tab, act); }
  }, true);

  async function poll() {
    const tab = currentTab();
    if (tab && on(tab)) {
      const p = agentPane(tab);
      const d = decks.get(tab.id);
      if (p?.claudeSession && d) {
        const f = await sb.agentFeed(p.claudeSession);
        if (f.found) d.feed = f;
      }
      paint(tab);
    }
    if (homeEl && !homeEl.hidden) paintHome();
  }

  // ------------------------------------------------------------ the Agents home
  function ensureHome() {
    if (homeEl) return homeEl;
    homeEl = document.createElement('section');
    homeEl.id = 'agent-home';
    homeEl.hidden = true;
    homeEl.innerHTML = `
      <div class="deck-grid" aria-hidden="true"></div>
      <div class="home-in">
        <header><div class="deck-label">agents</div><h1>Who should take this?</h1></header>
        <div class="summon"><span class="cmd-at">@</span><input spellcheck="false" placeholder="data-desk process the latest Excel from WhatsApp"><kbd>↵</kbd></div>
        <ol class="roster"></ol>
      </div>`;
    $('#stage #views').parentElement.appendChild(homeEl);
    const input = $('.summon input', homeEl);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      const list = agentList;
      if (e.key === 'Tab' && list.length) {
        e.preventDefault();
        homeSel = (homeSel + (e.shiftKey ? -1 : 1) + list.length) % list.length;
        const rest = input.value.replace(/^@?\S*\s*/, '');
        input.value = `${list[homeSel].name} ${rest}`;
        paintHome();
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const m = /^@?(\S+)\s*([\s\S]*)$/.exec(input.value.trim());
        const a = m && list.find((x) => x.name === m[1]);
        if (!a) return toast('Start with an agent name — Tab cycles through them');
        input.value = '';
        launch(a, m[2].trim() || null);
      }
    });
    homeEl.addEventListener('click', (e) => {
      const s = e.target.closest('[data-start]');
      if (s) { const a = agentList.find((x) => x.name === s.dataset.agent); if (a) launch(a, s.dataset.start || null); return; }
      const r = e.target.closest('[data-resume]');
      if (r) { const a = agentList.find((x) => x.name === r.dataset.resume); if (a) startAgent(a); return; }
      const f = e.target.closest('[data-file]');
      if (f) sb.openFile(f.dataset.file);
    });
    return homeEl;
  }

  function launch(a, prompt) {
    cfg.agentRuns = cfg.agentRuns || {};
    return openTab('agents', { name: a.name, path: a.dir }, { agent: a.name, prompt }).then((tab) => {
      if (prompt) { tab.name = prompt.split(/\s+/).slice(0, 7).join(' ') + (prompt.split(/\s+/).length > 7 ? '…' : ''); persist(); renderSidebar(); }
      return tab;
    });
  }

  function paintHome() {
    const el = ensureHome();
    const runs = cfg.agentRuns || {};
    const open = (name) => tabs.some((t) => leaves(t.root).some((id) => panes.get(id)?.agent === name));
    const html = agentList.map((a, i) => {
      const s = summaries[a.name];
      const live = open(a.name);
      return `<li class="${i === homeSel ? 'sel' : ''} ${live ? 'live' : ''}">
        <div class="r-head"><span class="r-name">${esc(a.name)}</span><span class="r-tag">${esc(a.tag || '')}</span>${live ? `<button class="r-open" data-resume="${esc(a.name)}">open session</button>` : ''}</div>
        ${s ? `<div class="r-last"><span class="deck-label">last</span> ${esc(s.task || '')} <time>${since(s.updatedAt)}</time>${s.files.length ? ` · ${s.files.map((f) => `<button class="r-file" data-file="${esc(f.path)}">${esc(f.name)}</button>`).join(' ')}` : ''}</div>` : ''}
        <div class="r-starts">${(a.starters || []).map((t) => `<button data-agent="${esc(a.name)}" data-start="${esc(t)}">${esc(t)}</button>`).join('')}<button class="blank" data-agent="${esc(a.name)}" data-start="">blank session</button></div>
      </li>`;
    }).join('') || '<li class="empty">No agents yet — add one to ~/.claude/agents.</li>';
    const ol = $('.roster', el);
    if (ol.dataset.html !== html) { ol.innerHTML = html; ol.dataset.html = html; }
  }

  async function refreshSummaries() {
    const runs = cfg.agentRuns || {};
    const map = {};
    for (const [name, r] of Object.entries(runs)) if (r?.session) map[name] = r.session;
    summaries = Object.keys(map).length ? await sb.agentSummaries(map) : {};
    if (homeEl && !homeEl.hidden) paintHome();
  }

  function home(show) {
    const el = ensureHome();
    el.hidden = !show;
    $('#empty').classList.toggle('under-home', show);
    if (show) { paintHome(); refreshSummaries(); setTimeout(() => { if (!editingName) $('.summon input', el).focus(); }, 60); }
  }

  function remember(name, session) {
    cfg.agentRuns = { ...(cfg.agentRuns || {}), [name]: { session, at: Date.now() } };
  }

  setInterval(poll, 1200);
  setInterval(refreshSummaries, 30000);
  return { attach, focus, home, remember, isAgentTab, on, paint, flip };
})();
