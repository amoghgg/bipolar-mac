// Live face net for the portal: MediaPipe Face Landmarker (468 points) running locally,
// drawn as a holographic wireframe over the camera feed. States: scan → near → match.
import { FaceLandmarker, FilesetResolver } from '../node_modules/@mediapipe/tasks-vision/vision_bundle.mjs';

let landmarker = null;
let video = null;
let canvas = null;
let ctx = null;
let raf = 0;
let state = 'scan';
let strength = 0;       // eased 0..1 brightness of the net
let flare = 0;          // 0..1 burst when recognised
let lastTs = -1;
let lastFace = null;
let sweep = 0;          // scan-line position through the face, 0..1

async function load() {
  if (landmarker) return landmarker;
  const files = await FilesetResolver.forVisionTasks('../node_modules/@mediapipe/tasks-vision/wasm');
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: './assets/face_landmarker.task', delegate },
    runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: false,
  });
  try { landmarker = await FaceLandmarker.createFromOptions(files, opts('GPU')); }
  catch { landmarker = await FaceLandmarker.createFromOptions(files, opts('CPU')); }
  return landmarker;
}

function fitCanvas() {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(r.width * dpr)) {
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
  }
}

// Map normalised landmark coords onto the mirrored, object-fit:cover video circle.
function mapper() {
  const W = canvas.width, H = canvas.height;
  const vw = video.videoWidth, vh = video.videoHeight;
  const s = Math.max(W / vw, H / vh);
  const dw = vw * s, dh = vh * s;
  const ox = (W - dw) / 2, oy = (H - dh) / 2;
  return (p) => [W - (ox + p.x * dw), oy + p.y * dh];
}

function draw(face) {
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!face) return;
  const map = mapper();
  const pts = face.map(map);
  let minY = Infinity, maxY = -Infinity;
  for (const [, y] of pts) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
  const sweepY = minY + (maxY - minY) * sweep;

  const grad = ctx.createLinearGradient(0, minY, W, maxY);
  grad.addColorStop(0, '#c6b6ff'); grad.addColorStop(0.4, '#93e4f6'); grad.addColorStop(0.75, '#ffbaa5'); grad.addColorStop(1, '#f6a8d9');
  const dpr = window.devicePixelRatio || 1;

  // the net
  ctx.lineWidth = (0.55 + flare * 0.6) * dpr;
  ctx.strokeStyle = grad;
  ctx.globalAlpha = 0.16 + strength * 0.42 + flare * 0.4;
  ctx.beginPath();
  for (const { start, end } of FaceLandmarker.FACE_LANDMARKS_TESSELATION) {
    const a = pts[start], b = pts[end];
    ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
  }
  ctx.stroke();

  // the contours: eyes, brows, lips, face oval — the "recognised" silhouette
  ctx.lineWidth = (1 + strength * 0.6 + flare) * dpr;
  ctx.globalAlpha = 0.35 + strength * 0.55;
  ctx.shadowColor = 'rgba(198,182,255,.8)';
  ctx.shadowBlur = (4 + flare * 14) * dpr;
  ctx.beginPath();
  for (const { start, end } of FaceLandmarker.FACE_LANDMARKS_CONTOURS) {
    const a = pts[start], b = pts[end];
    ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
  }
  ctx.stroke();
  ctx.shadowBlur = 0;

  // points lit by the scan line while searching
  if (state !== 'match') {
    ctx.fillStyle = '#eeeaf4';
    for (const [x, y] of pts) {
      const d = Math.abs(y - sweepY);
      if (d < 14 * dpr) { ctx.globalAlpha = (1 - d / (14 * dpr)) * 0.9; ctx.fillRect(x - dpr * 0.8, y - dpr * 0.8, dpr * 1.6, dpr * 1.6); }
    }
  }
  ctx.globalAlpha = 1;
}

function tick() {
  raf = requestAnimationFrame(tick);
  if (!video || video.readyState < 2 || !landmarker) return;
  fitCanvas();
  const ts = performance.now();
  if (ts !== lastTs) {
    try {
      const res = landmarker.detectForVideo(video, ts);
      lastFace = res.faceLandmarks?.[0] || null;
    } catch {}
    lastTs = ts;
  }
  const target = state === 'match' ? 1 : state === 'near' ? 0.55 : 0.2;
  strength += (target - strength) * 0.08;
  flare *= 0.94;
  sweep = (sweep + (state === 'match' ? 0 : 0.012)) % 1;
  draw(lastFace);
}

window.PortalMesh = {
  async start(v, c) {
    video = v; canvas = c; ctx = c.getContext('2d');
    state = 'scan'; strength = 0; flare = 0;
    cancelAnimationFrame(raf);
    try { await load(); } catch (e) { console.warn('face mesh unavailable', e); return false; }
    tick();
    return true;
  },
  setState(s) {
    if (s === 'match' && state !== 'match') flare = 1;
    state = s;
  },
  hasFace: () => !!lastFace,
  stop() { cancelAnimationFrame(raf); raf = 0; lastFace = null; ctx?.clearRect(0, 0, canvas.width, canvas.height); },
};
