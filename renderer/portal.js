/* The portal: Bipolar's landing screen. Unlocks with your own face API (kept warm in
   the background) or Touch ID, Face-ID style: no camera preview, just a glyph and
   three words — look, verifying, verified. Sessions keep running behind it. */
'use strict';

const Portal = (() => {
  const EPIGRAPHS = [
    ['Less, but better.', 'Dieter Rams'],
    ['The details are not the details. They make the design.', 'Charles Eames'],
    ['Complicating is easy, simplifying is difficult.', 'Bruno Munari'],
    ['Art is something that makes you breathe with a different kind of happiness.', 'Anni Albers'],
    ['We shape our tools and thereafter our tools shape us.', 'John Culkin'],
    ['Have nothing in your house that you do not know to be useful, or believe to be beautiful.', 'William Morris'],
  ];
  const el = (id) => document.getElementById(id);
  let stream = null;
  let running = false;
  let mode = 'verify';
  let lastSim = 0;
  let onOpen = () => {};
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function greeting() {
    const h = new Date().getHours();
    return h < 5 ? 'Still up' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : h < 22 ? 'Good evening' : 'Late night';
  }
  function tickClock() {
    const d = new Date();
    el('pt-time').textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    el('pt-date').textContent = d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }).toLowerCase();
  }
  function show(state, text, tone = '') {
    el('pt-fid').dataset.state = state;
    const s = el('pt-status');
    s.textContent = text;
    s.dataset.tone = tone;
  }

  async function startCamera() {
    if (stream) return true;
    if (!(await sb.cameraAccess())) return false;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false });
      const v = el('pt-video');
      v.srcObject = stream;
      await v.play();
      return true;
    } catch { return false; }
  }
  function stopCamera() { stream?.getTracks().forEach((t) => t.stop()); stream = null; }
  function frame() {
    const v = el('pt-video');
    if (!v.videoWidth) return null;
    const c = document.createElement('canvas');
    c.width = 512; c.height = Math.round((v.videoHeight / v.videoWidth) * 512);
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.85).split(',')[1];
  }

  async function loop() {
    let misses = 0;
    while (running) {
      if (mode === 'enroll') { await wait(150); continue; }
      const img = frame();
      if (!img) { await wait(80); continue; }
      const r = await sb.face.verify(img);
      if (!running) return;
      if (!r.ok) {
        if (r.error === 'enrolment lost' || r.error === 'not enrolled') return askEnroll();
        show('looking', 'Getting ready…');
        await wait(400);
        continue;
      }
      if (!r.face) { lastSim = 0; show('looking', 'Look at your Mac'); await wait(120); continue; }
      // One frame over the bar is enough; a less-than-certain pass teaches the portal this look.
      // Two steady frames just under the bar also count (ArcFace puts other people far below 0.44).
      if (r.match || (r.similarity >= 0.44 && lastSim >= 0.44)) {
        if (r.similarity < 0.68) sb.face.learn(img);
        return open('face');
      }
      show('verifying', 'Verifying face…');
      if (!r.match && ++misses > 6) { show('fail', 'Not recognised. Try again, or use Touch ID.', 'warn'); misses = 0; await wait(900); }
      lastSim = r.similarity;
    }
  }

  function askEnroll() {
    mode = 'enroll';
    el('pt-enroll').hidden = false;
    show('looking', 'First time here. Bipolar needs to learn your face.');
  }
  async function enroll() {
    const img = frame();
    if (!img) return show('looking', 'The camera isn’t ready yet.', 'warn');
    el('pt-enroll').disabled = true;
    show('verifying', 'Learning your face…');
    const r = await sb.face.enroll(img);
    el('pt-enroll').disabled = false;
    if (!r.ok) return show('fail', 'Couldn’t see a face clearly. Face the camera in good light.', 'warn');
    el('pt-enroll').hidden = true;
    mode = 'verify';
    show('looking', 'Learned. Look again to open.', 'ok');
  }

  async function touch() {
    show('verifying', 'Waiting for Touch ID…');
    const r = await sb.touchId();
    if (r.ok) return open('touch');
    show('fail', r.error, 'warn');
  }

  async function open(how) {
    running = false;
    stopCamera();
    show('verified', 'Verified', 'ok');
    await wait(how === 'face' ? 520 : 300);
    el('portal').classList.add('opening');
    await wait(950);
    el('portal').hidden = true;
    el('portal').classList.remove('opening');
    document.body.classList.remove('locked');
    onOpen(how);
  }

  async function lock() {
    if (!el('portal').hidden && running) return;
    document.body.classList.add('locked');
    el('portal').hidden = false;
    el('portal').classList.remove('opening');
    const [q, who] = EPIGRAPHS[Math.floor(Date.now() / 864e5) % EPIGRAPHS.length];
    el('pt-quote').textContent = q;
    el('pt-quote-by').textContent = who;
    el('pt-greet').textContent = greeting();
    tickClock();
    el('pt-enroll').hidden = true;
    show('looking', 'Look at your Mac');
    running = true;
    lastSim = 0;
    const [cam, state, up] = await Promise.all([startCamera(), sb.face.state(), sb.face.up()]);
    if (!running) return;
    if (!cam) { running = false; return show('fail', 'No camera access. Use Touch ID, or allow the camera in System Settings › Privacy.', 'warn'); }
    if (!up.ok) { running = false; return show('fail', 'Face service unavailable. Use Touch ID.', 'warn'); }
    mode = state.enrolled ? 'verify' : 'enroll';
    if (!state.enrolled) askEnroll();
    loop();
  }

  function stats(text) { el('pt-stats').textContent = text; }

  function init(opts) {
    onOpen = opts.onOpen || onOpen;
    setInterval(tickClock, 10000);
    el('pt-touch').addEventListener('click', touch);
    el('pt-enroll').addEventListener('click', enroll);
    document.addEventListener('keydown', (e) => {
      if (el('portal').hidden) return;
      if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); touch(); }
      else if (e.key === 'Enter' && mode === 'enroll' && !el('pt-enroll').hidden) { e.preventDefault(); enroll(); }
    }, true);
    sb.onLock(() => lock());
  }

  return { init, lock, stats, get locked() { return !el('portal').hidden; } };
})();
