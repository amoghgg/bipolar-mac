/* The portal: the landing screen. Work begins only after your face is recognised
   by your own face API (or Touch ID). Sessions keep running behind it. */
'use strict';

const Portal = (() => {
  const EPIGRAPHS = [
    ['Less, but better.', 'Dieter Rams'],
    ['The details are not the details. They make the design.', 'Charles Eames'],
    ['Complicating is easy, simplifying is difficult.', 'Bruno Munari'],
    ['Art is something that makes you breathe with a different kind of happiness.', 'Anni Albers'],
    ['We shape our tools and thereafter our tools shape us.', 'John Culkin'],
    ['Design is not just what it looks like and feels like. Design is how it works.', 'Steve Jobs'],
    ['Have nothing in your house that you do not know to be useful, or believe to be beautiful.', 'William Morris'],
  ];
  const el = (id) => document.getElementById(id);
  let stream = null;
  let running = false;
  let streak = 0;
  let mode = 'verify';
  let onOpen = () => {};

  function greeting() {
    const h = new Date().getHours();
    return h < 5 ? 'Still up' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : h < 22 ? 'Good evening' : 'Late night';
  }
  function tickClock() {
    const d = new Date();
    el('pt-time').textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    el('pt-date').textContent = d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }).toLowerCase();
  }
  function say(text, tone = '') {
    const s = el('pt-status');
    s.textContent = text;
    s.dataset.tone = tone;
  }
  function setRing(v) { el('portal').style.setProperty('--match', Math.max(0, Math.min(1, v)).toFixed(3)); }

  async function startCamera() {
    if (stream) return true;
    if (!(await sb.cameraAccess())) return false;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: 960, height: 720, facingMode: 'user' }, audio: false });
      const v = el('pt-video');
      v.srcObject = stream;
      await v.play();
      el('portal').classList.add('live');
      return true;
    } catch { return false; }
  }
  function stopCamera() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    el('portal').classList.remove('live');
  }
  function frame() {
    const v = el('pt-video');
    if (!v.videoWidth) return null;
    const c = document.createElement('canvas');
    const w = 640; c.width = w; c.height = Math.round((v.videoHeight / v.videoWidth) * w);
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.88).split(',')[1];
  }

  async function loop() {
    while (running) {
      const img = frame();
      if (!img) { await wait(200); continue; }
      if (mode === 'enroll') { await wait(200); continue; }
      const r = await sb.face.verify(img);
      if (!running) return;
      if (!r.ok) {
        if (r.error === 'enrolment lost' || r.error === 'not enrolled') return askEnroll();
        say('The face service hiccuped. Trying again…', 'warn');
        await wait(900);
        continue;
      }
      if (!r.face) { streak = 0; setRing(0.04); say('Step into the light. I can’t see your face.'); }
      else if (r.match) {
        streak++; setRing(r.similarity);
        say(streak >= 2 ? 'Recognised.' : 'Hold still…', 'ok');
        if (streak >= 2) return open('face');
      } else { streak = 0; setRing(r.similarity * 0.8); say('Not quite you. Look straight into the portal.', 'warn'); }
      await wait(350);
    }
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function askEnroll() {
    mode = 'enroll';
    el('portal').classList.add('enrolling');
    el('pt-enroll').hidden = false;
    say('First time here. Let the portal learn your face.');
  }
  async function enroll() {
    const img = frame();
    if (!img) return say('The camera isn’t ready yet.', 'warn');
    el('pt-enroll').disabled = true;
    say('Learning your face…');
    const r = await sb.face.enroll(img);
    el('pt-enroll').disabled = false;
    if (!r.ok) return say(r.error === 'No face detected in the image' ? 'I couldn’t find a face. Face the camera in good light.' : `Couldn’t learn your face: ${r.error}`, 'warn');
    el('portal').classList.remove('enrolling');
    el('pt-enroll').hidden = true;
    mode = 'verify';
    say('Learned. Now look again to open.', 'ok');
    streak = 0;
  }

  async function touch() {
    say('Waiting for Touch ID…');
    const r = await sb.touchId();
    if (r.ok) return open('touch');
    say(r.error, 'warn');
  }

  async function open(how) {
    running = false;
    el('portal').classList.add('opening');
    setRing(1);
    stopCamera();
    sb.face.down();
    await wait(1150);
    el('portal').hidden = true;
    el('portal').classList.remove('opening');
    document.body.classList.remove('locked');
    onOpen(how);
  }

  async function lock() {
    if (!el('portal').hidden && running) return;
    document.body.classList.add('locked');
    const p = el('portal');
    p.hidden = false;
    p.classList.remove('opening');
    setRing(0);
    streak = 0;
    const [q, who] = EPIGRAPHS[Math.floor(Date.now() / 864e5) % EPIGRAPHS.length];
    el('pt-quote').textContent = q;
    el('pt-quote-by').textContent = who;
    el('pt-greet').textContent = greeting();
    tickClock();
    el('pt-enroll').hidden = true;
    say('Waking the portal…');
    running = true;
    const [cam, state, up] = await Promise.all([startCamera(), sb.face.state(), sb.face.up()]);
    if (!running) return;
    if (!cam) { running = false; return say('No camera access. Use Touch ID, or allow the camera in System Settings › Privacy.', 'warn'); }
    if (!up.ok) { running = false; return say(`Face service unavailable (${up.error}). Use Touch ID.`, 'warn'); }
    if (!state.enrolled) askEnroll(); else { mode = 'verify'; say('Look into the portal.'); }
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
