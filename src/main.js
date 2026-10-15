import './style.css';
import Module from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { SECTIONS, PRESETS } from './ui/schema.js';
import { Preview3D } from './ui/preview3d.js';
import { DEFAULTS, build2D, build3D } from './core/pipeline.js';
import { computeLayout } from './core/compose.js';
import { toBinarySTL, toSVG } from './core/mesh.js';
import { makeZip } from './core/zip.js';
import {
  SAMPLES,
  autoThreshold,
  detectSettings,
  loadImageFile,
  renderPlacedArt,
  renderTextMask,
  rgbToHex,
  sampleCanvas,
} from './image.js';

const STORAGE_KEY = 'imgtostl:settings:v1';
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  s: loadSettings(),
  source: null,
  sourceName: 'silhouette',
  result2d: null,
  result3d: null,
  wasm: null,
  picking: false,
  version: 0,
  tool: 'move', // move | add | erase
  brush: 3, // mm diameter
  strokes: [], // hand edits, mm coordinates
  drawing: null,
};

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.s));
  } catch {
    /* storage unavailable */
  }
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
const controlEls = new Map();
const sectionEls = [];

function fmt(v, step) {
  const decimals = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  return Number(v).toFixed(decimals);
}

function buildControls() {
  const form = $('controls');
  form.innerHTML = '';
  for (const sec of SECTIONS) {
    const det = document.createElement('details');
    det.className = 'section';
    det.open = sec.open;
    const sum = document.createElement('summary');
    sum.textContent = sec.title;
    det.appendChild(sum);
    if (sec.hint) {
      const p = document.createElement('p');
      p.className = 'section-hint';
      p.textContent = sec.hint;
      det.appendChild(p);
    }
    for (const c of sec.controls) det.appendChild(buildControl(c));
    form.appendChild(det);
    sectionEls.push({ sec, det });
  }
  syncControls();
}

function buildControl(c) {
  const wrap = document.createElement('div');
  wrap.className = `ctl ${c.type === 'checkbox' ? 'check' : c.type}`;
  const id = `c-${c.key}`;
  if (c.type === 'checkbox') {
    wrap.innerHTML = `<label><input type="checkbox" id="${id}"> ${c.label}</label>`;
    const input = wrap.querySelector('input');
    input.addEventListener('change', () => set({ [c.key]: input.checked }));
  } else if (c.type === 'select') {
    wrap.innerHTML = `<label for="${id}">${c.label}</label><select id="${id}">${c.options
      .map(([v, l]) => `<option value="${v}">${l}</option>`)
      .join('')}</select>`;
    const input = wrap.querySelector('select');
    input.addEventListener('change', () => set({ [c.key]: input.value }));
  } else if (c.type === 'text') {
    wrap.innerHTML = `<label for="${id}">${c.label}</label><input type="text" id="${id}" maxlength="${c.maxLength || 60}" placeholder="${c.placeholder || ''}" spellcheck="false">`;
    const input = wrap.querySelector('input');
    input.addEventListener('input', () => set({ [c.key]: input.value }));
  } else if (c.type === 'color') {
    wrap.innerHTML = `<div class="row"><label for="${id}">${c.label}</label><span><input type="color" id="${id}"> ${
      c.pick ? '<button type="button" class="btn small ghost" data-pick>Pick from image</button>' : ''
    }</span></div>`;
    const input = wrap.querySelector('input');
    input.addEventListener('input', () => set({ [c.key]: input.value }));
    wrap.querySelector('[data-pick]')?.addEventListener('click', () => setPicking(!state.picking));
  } else {
    wrap.innerHTML = `<div class="row"><label for="${id}">${c.label}</label><span><input class="num" type="number" step="${c.step}" aria-label="${c.label} value"> <small>${
      c.unit || ''
    }</small></span></div><input type="range" id="${id}" min="${c.min}" max="${c.max}" step="${c.step}">`;
    const range = wrap.querySelector('input[type=range]');
    const num = wrap.querySelector('.num');
    range.addEventListener('input', () => set({ [c.key]: parseFloat(range.value) }));
    num.addEventListener('change', () => {
      const v = parseFloat(num.value);
      if (Number.isFinite(v)) set({ [c.key]: v });
    });
  }
  if (c.hint) {
    const h = document.createElement('div');
    h.className = 'hint';
    h.textContent = c.hint;
    wrap.appendChild(h);
  }
  controlEls.set(c.key, { def: c, wrap });
  return wrap;
}

function syncControls() {
  const s = state.s;
  for (const { sec, det } of sectionEls) det.hidden = sec.show ? !sec.show(s) : false;
  for (const [key, { def, wrap }] of controlEls) {
    wrap.hidden = def.show ? !def.show(s) : false;
    const v = s[key];
    if (def.type === 'checkbox') wrap.querySelector('input').checked = !!v;
    else if (def.type === 'select') wrap.querySelector('select').value = v;
    else if (def.type === 'color') wrap.querySelector('input[type=color]').value = v;
    else if (def.type === 'text') {
      const input = wrap.querySelector('input');
      if (document.activeElement !== input) input.value = v || '';
    }
    else {
      const range = wrap.querySelector('input[type=range]');
      const num = wrap.querySelector('.num');
      if (document.activeElement !== range) range.value = v;
      if (document.activeElement !== num) num.value = fmt(v, def.step);
    }
  }
}

function set(patch, { rerun = true } = {}) {
  Object.assign(state.s, patch);
  if (state.source && state.s.autoThreshold && ('mode' in patch || 'invert' in patch || 'keyColor' in patch)) {
    state.s.threshold = Math.round(autoThreshold(state.source, state.s));
  }
  saveSettings();
  syncControls();
  if (rerun) schedule();
}

// ---------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------
let timer = 0;
function schedule(delay = 40) {
  clearTimeout(timer);
  $('busy').hidden = false;
  timer = setTimeout(run, delay);
}

async function run() {
  const version = ++state.version;
  const s = { ...state.s };
  try {
    const layout = computeLayout(s);
    const { ink, rgba } = renderPlacedArt(state.source, layout, s);
    const cut = s.mode === 'alpha' || !s.autoThreshold ? s.threshold : state.s.threshold;
    const textMask = renderTextMask(layout, s);
    const r = build2D(s, layout, ink, cut, { strokes: state.strokes, textMask });
    r.rgba = rgba;
    state.result2d = r;
    draw2D();
    // Let the 2D preview paint before the heavier 3D step.
    await new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
    if (version !== state.version) return;
    const wasm = await getWasm();
    if (version !== state.version) return;
    state.result3d?.dispose();
    state.result3d = null;
    if (!r.solidPolys.length) {
      preview3d.show(null);
      renderStatus();
      return;
    }
    const m = build3D(wasm, s, r);
    state.result3d = m;
    preview3d.show(m.previewMesh, m.standMesh, Math.max(s.artThickness, s.frameThickness));
    renderStatus();
  } catch (err) {
    console.error(err);
    $('status').innerHTML = `<span class="badge bad">Error: ${escapeHtml(err.message || String(err))}</span>`;
  } finally {
    if (version === state.version) $('busy').hidden = true;
    updateButtons();
  }
}

let wasmPromise = null;
function getWasm() {
  if (!wasmPromise) {
    // A single-file build inlines the wasm as a data: URL; hand the bytes
    // over directly so no network fetch is needed.
    const opts = wasmUrl.startsWith('data:')
      ? { wasmBinary: Uint8Array.from(atob(wasmUrl.slice(wasmUrl.indexOf(',') + 1)), (c) => c.charCodeAt(0)) }
      : { locateFile: () => wasmUrl };
    wasmPromise = Module(opts).then((w) => {
      w.setup();
      state.wasm = w;
      return w;
    });
  }
  return wasmPromise;
}

function escapeHtml(t) {
  return t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

// ---------------------------------------------------------------------------
// 2D preview
// ---------------------------------------------------------------------------
const canvas2d = $('canvas2d');

function cssColor(name) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const c = document.createElement('canvas').getContext('2d');
  c.fillStyle = v || '#000';
  const hex = c.fillStyle;
  if (hex.startsWith('#')) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = hex.match(/\d+/g) || [0, 0, 0];
  return m.slice(0, 3).map(Number);
}

function draw2D() {
  const r = state.result2d;
  if (!r) return;
  const { layout, composed } = r;
  canvas2d.width = layout.w;
  canvas2d.height = layout.h;
  const ctx = canvas2d.getContext('2d');
  const img = ctx.createImageData(layout.w, layout.h);
  const out = img.data;
  const C = {
    frame: cssColor('--frame'),
    art: cssColor('--art'),
    bridge: cssColor('--bridge'),
    thin: cssColor('--thin'),
    removed: cssColor('--removed'),
    stage: cssColor('--stage'),
  };
  // Depth layers: lower layers drawn lighter so the stack reads at a glance.
  const levels = r.levels;
  const maxLevel = r.stats.layers - 1;
  const shade = (k) => {
    const t = maxLevel > 0 ? 0.6 * (1 - k / maxLevel) : 0;
    return C.art.map((v, j) => Math.round(v * (1 - t) + C.stage[j] * t));
  };
  const shades = Array.from({ length: maxLevel + 1 }, (_, k) => shade(k));
  const text = composed.text && state.s.textMode !== 'cutout' ? composed.text : null;
  const showPhoto = $('v-photo').checked;
  const showIssues = $('v-issues').checked;
  const src = r.rgba.data;
  const { solid, anchor, thin } = composed;
  const { bridgeMask, removed } = composed.islands;
  for (let i = 0; i < solid.data.length; i++) {
    let col = null;
    let a = 255;
    if (solid.data[i]) {
      col = anchor.data[i] ? (text && text.data[i] ? C.art : C.frame) : shades[levels[i]];
      if (showIssues && bridgeMask.data[i] && !anchor.data[i]) col = C.bridge;
      if (showIssues && thin.data[i]) col = C.thin;
      if (showPhoto) a = 150;
    } else if (showIssues && removed.data[i]) {
      col = C.removed;
      a = 110;
    } else if (showPhoto && src[4 * i + 3]) {
      out[4 * i] = src[4 * i];
      out[4 * i + 1] = src[4 * i + 1];
      out[4 * i + 2] = src[4 * i + 2];
      out[4 * i + 3] = src[4 * i + 3] * 0.6;
      continue;
    }
    if (col) {
      out[4 * i] = col[0];
      out[4 * i + 1] = col[1];
      out[4 * i + 2] = col[2];
      out[4 * i + 3] = a;
    }
  }
  if (showPhoto) {
    // blend photo under translucent solids
    for (let i = 0; i < solid.data.length; i++) {
      if (solid.data[i] && src[4 * i + 3]) {
        for (let c = 0; c < 3; c++) out[4 * i + c] = (out[4 * i + c] * 0.6 + src[4 * i + c] * 0.4) | 0;
        out[4 * i + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);

  if ($('v-outline').checked) {
    ctx.save();
    ctx.lineWidth = Math.max(1, layout.w / 700);
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#f60';
    ctx.beginPath();
    for (const loop of r.loops) {
      ctx.moveTo(loop[0] + 0.5, loop[1] + 0.5);
      for (let i = 2; i < loop.length; i += 2) ctx.lineTo(loop[i] + 0.5, loop[i + 1] + 0.5);
      ctx.closePath();
    }
    ctx.stroke();
    ctx.restore();
  }
  if (state.drawing) drawStroke(ctx, state.drawing);
  $('drop-hint').style.display = state.source ? '' : 'flex';
}

// Live preview of a stroke while it is being painted.
function drawStroke(ctx, st) {
  const L = state.result2d.layout;
  ctx.save();
  ctx.lineCap = ctx.lineJoin = 'round';
  ctx.lineWidth = st.r * 2 * L.res;
  ctx.strokeStyle = st.mode === 'erase' ? 'rgba(239,68,68,0.55)' : 'rgba(22,163,74,0.6)';
  ctx.beginPath();
  st.points.forEach(([x, y], i) => {
    const px = (x - L.minX) * L.res;
    const py = (y - L.minY) * L.res;
    if (i) ctx.lineTo(px, py);
    else ctx.moveTo(px, py);
  });
  if (st.points.length === 1) ctx.lineTo((st.points[0][0] - L.minX) * L.res + 0.01, (st.points[0][1] - L.minY) * L.res);
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Status / stats
// ---------------------------------------------------------------------------
function renderStatus() {
  const r = state.result2d;
  const m = state.result3d;
  const s = state.s;
  const badges = [];
  if (!r) return;
  if (!state.source) badges.push(['', 'No image yet — open one or try a sample']);
  if (r.stats.pieces === 1) badges.push(['ok', '✓ One solid piece — nothing falls out']);
  else if (r.stats.pieces > 1) badges.push(['bad', `⚠ ${r.stats.pieces} separate pieces`]);
  if (r.stats.bridges) badges.push(['', `${r.stats.bridges} bridge${r.stats.bridges > 1 ? 's' : ''} added`]);
  if (r.stats.removed) badges.push(['warn', `${r.stats.removed} speck${r.stats.removed > 1 ? 's' : ''} dropped`]);
  if (r.stats.layers > 1) badges.push(['', `${r.stats.layers} depth layers`]);
  if (state.strokes.length) badges.push(['', `${state.strokes.length} hand edit${state.strokes.length > 1 ? 's' : ''}`]);
  if (r.stats.thinArea > 0.5)
    badges.push(['warn', `⚠ ${r.stats.thinArea.toFixed(0)} mm² thinner than ${s.minFeature} mm`]);
  if (m) {
    const bb = m.info.bbox;
    const size = [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]];
    badges.push(['', `${size.map((v) => v.toFixed(1)).join(' × ')} mm`]);
    const cm3 = m.info.volume / 1000;
    badges.push(['', `${cm3.toFixed(1)} cm³ ≈ ${(cm3 * 1.24).toFixed(0)} g PLA`]);
    badges.push(['', `${m.info.triangles.toLocaleString()} triangles`]);
    if (m.info.status === 'NoError') badges.push(['ok', '✓ Watertight']);
    else badges.push(['bad', `Mesh: ${m.info.status}`]);
    if (m.stand) badges.push(['', `Stand ≈ ${((m.info.standVolume / 1000) * 1.24).toFixed(0)} g`]);
  }
  $('status').innerHTML = badges.map(([cls, t]) => `<span class="badge ${cls}">${escapeHtml(t)}</span>`).join('');
}

function updateButtons() {
  const has = !!state.result3d;
  $('dl-stl').disabled = !has;
  $('dl-svg').disabled = !(state.result2d && state.result2d.solidPolys.length);
  const stand = $('dl-stand');
  stand.hidden = !(state.result3d && state.result3d.stand);
  stand.disabled = stand.hidden;
}

// ---------------------------------------------------------------------------
// Image input
// ---------------------------------------------------------------------------
async function useSource(canvas, name) {
  state.source = canvas;
  state.sourceName = (name || 'silhouette').replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_') || 'silhouette';
  const detected = detectSettings(canvas);
  state.strokes = [];
  updateTools();
  const patch = { ...detected, artScale: 1, offsetX: 0, offsetY: 0, rotation: 0, flipX: false, autoThreshold: true };
  Object.assign(state.s, patch);
  if (state.s.mode !== 'alpha') state.s.threshold = Math.round(autoThreshold(canvas, state.s));
  saveSettings();
  syncControls();
  preview3d.fitted = false;
  schedule(0);
}

async function openFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  try {
    const c = await loadImageFile(file);
    useSource(c, file.name);
  } catch (e) {
    $('status').innerHTML = `<span class="badge bad">${escapeHtml(e.message)}</span>`;
  }
}

$('file').addEventListener('change', (e) => {
  openFile(e.target.files[0]);
  e.target.value = '';
});

const stage2d = $('stage2d');
for (const ev of ['dragenter', 'dragover']) {
  document.addEventListener(ev, (e) => {
    e.preventDefault();
    stage2d.classList.add('dragover');
  });
}
for (const ev of ['dragleave', 'drop']) {
  document.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'drop' || e.target === document.documentElement) stage2d.classList.remove('dragover');
  });
}
document.addEventListener('drop', (e) => openFile(e.dataTransfer?.files?.[0]));
document.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) openFile(item.getAsFile());
});

for (const [key, { label }] of Object.entries(SAMPLES)) {
  const b = document.createElement('button');
  b.className = 'btn ghost';
  b.textContent = label;
  b.title = 'Load sample artwork';
  b.addEventListener('click', () => useSource(sampleCanvas(key), key));
  $('samples').appendChild(b);
}

for (const [, preset] of Object.entries(PRESETS)) {
  const b = document.createElement('button');
  b.className = 'chip';
  b.type = 'button';
  b.textContent = preset.label;
  b.addEventListener('click', () => {
    preview3d.fitted = false;
    set(preset.values);
  });
  $('presets').appendChild(b);
}

$('reset').addEventListener('click', () => {
  const keep = { mode: state.s.mode, invert: state.s.invert, threshold: state.s.threshold, keyColor: state.s.keyColor };
  state.s = { ...DEFAULTS, ...(state.source ? keep : {}) };
  preview3d.fitted = false;
  saveSettings();
  syncControls();
  schedule();
});

// ---------------------------------------------------------------------------
// Direct manipulation on the 2D canvas
// ---------------------------------------------------------------------------
function setPicking(on) {
  state.picking = on;
  canvas2d.classList.toggle('picking', on);
  $('pick-hint').hidden = !on;
}

function canvasPoint(e) {
  const rect = canvas2d.getBoundingClientRect();
  const k = canvas2d.width / rect.width;
  return { x: (e.clientX - rect.left) * k, y: (e.clientY - rect.top) * k, k };
}

const pointers = new Map();
let gesture = null;

canvas2d.addEventListener('pointerdown', (e) => {
  if (!state.result2d) return;
  if (state.picking) {
    const { x, y } = canvasPoint(e);
    const { w, h } = state.result2d.layout;
    const px = Math.max(0, Math.min(w - 1, Math.floor(x)));
    const py = Math.max(0, Math.min(h - 1, Math.floor(y)));
    const d = state.result2d.rgba.data;
    const i = 4 * (py * w + px);
    if (d[i + 3] > 0) set({ mode: 'color', keyColor: rgbToHex([d[i], d[i + 1], d[i + 2]]) });
    setPicking(false);
    return;
  }
  canvas2d.setPointerCapture(e.pointerId);
  if (state.tool !== 'move' && pointers.size === 0) {
    state.drawing = { mode: state.tool, r: state.brush / 2, points: [pointToMm(e)], id: e.pointerId };
    draw2D();
    return;
  }
  if (state.drawing) {
    // A second finger turns painting into pinch/pan.
    state.drawing = null;
    draw2D();
  }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  canvas2d.classList.add('dragging');
  gesture = startGesture();
});

function pointToMm(e) {
  const { x, y } = canvasPoint(e);
  const L = state.result2d.layout;
  return [round(L.minX + x / L.res, 0.01), round(L.minY + y / L.res, 0.01)];
}

function startGesture() {
  const pts = [...pointers.values()];
  const center = pts.reduce((a, p) => ({ x: a.x + p.x / pts.length, y: a.y + p.y / pts.length }), { x: 0, y: 0 });
  const spread = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
  return { center, spread, s0: { ...state.s } };
}

canvas2d.addEventListener('pointermove', (e) => {
  if (state.drawing && state.drawing.id === e.pointerId) {
    const p = pointToMm(e);
    const last = state.drawing.points[state.drawing.points.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) > state.drawing.r * 0.4) {
      state.drawing.points.push(p);
      drawStroke(canvas2d.getContext('2d'), state.drawing);
    }
    return;
  }
  if (!pointers.has(e.pointerId) || !gesture) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const pts = [...pointers.values()];
  const center = pts.reduce((a, p) => ({ x: a.x + p.x / pts.length, y: a.y + p.y / pts.length }), { x: 0, y: 0 });
  const rect = canvas2d.getBoundingClientRect();
  const mmPerCss = canvas2d.width / rect.width / state.result2d.layout.res;
  const patch = {
    offsetX: round(gesture.s0.offsetX + (center.x - gesture.center.x) * mmPerCss, 0.5),
    offsetY: round(gesture.s0.offsetY + (center.y - gesture.center.y) * mmPerCss, 0.5),
  };
  if (pts.length > 1 && gesture.spread > 0) {
    const spread = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    patch.artScale = clamp(round(gesture.s0.artScale * (spread / gesture.spread), 0.01), 0.1, 3);
  }
  set(patch);
});

const endPointer = (e) => {
  if (state.drawing && state.drawing.id === e.pointerId) {
    const { mode, r, points } = state.drawing;
    state.drawing = null;
    if (e.type === 'pointerup') {
      state.strokes.push({ mode, r, points });
      updateTools();
      schedule(0);
    } else draw2D();
    return;
  }
  pointers.delete(e.pointerId);
  canvas2d.classList.remove('dragging');
  gesture = pointers.size ? startGesture() : null;
};
canvas2d.addEventListener('pointerup', endPointer);
canvas2d.addEventListener('pointercancel', endPointer);

canvas2d.addEventListener(
  'wheel',
  (e) => {
    if (!state.source) return;
    e.preventDefault();
    const k = Math.exp(-e.deltaY * 0.0015);
    set({ artScale: clamp(round(state.s.artScale * k, 0.01), 0.1, 3) });
  },
  { passive: false },
);

function round(v, step) {
  return Math.round(v / step) * step;
}
function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

for (const id of ['v-photo', 'v-outline', 'v-issues']) $(id).addEventListener('change', draw2D);

// ---------------------------------------------------------------------------
// Brush tools
// ---------------------------------------------------------------------------
function updateTools() {
  for (const b of document.querySelectorAll('[data-tool]')) {
    const on = b.dataset.tool === state.tool;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on);
  }
  canvas2d.dataset.tool = state.tool;
  $('brush-size').closest('.brush').hidden = state.tool === 'move';
  $('undo-edit').disabled = !state.strokes.length;
  $('clear-edits').disabled = !state.strokes.length;
}

function undoEdit() {
  if (!state.strokes.length) return;
  state.strokes.pop();
  updateTools();
  schedule(0);
}

for (const b of document.querySelectorAll('[data-tool]')) {
  b.addEventListener('click', () => {
    state.tool = b.dataset.tool;
    updateTools();
  });
}
$('brush-size').addEventListener('input', (e) => {
  state.brush = parseFloat(e.target.value);
  $('brush-out').textContent = `${state.brush.toFixed(1)} mm`;
});
$('undo-edit').addEventListener('click', undoEdit);
$('clear-edits').addEventListener('click', () => {
  state.strokes = [];
  updateTools();
  schedule(0);
});
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName) && document.activeElement.type !== 'range';
  if (typing) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undoEdit();
  } else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
    const k = { v: 'move', b: 'add', e: 'erase' }[e.key.toLowerCase()];
    if (k) {
      state.tool = k;
      updateTools();
    }
  }
});

// ---------------------------------------------------------------------------
// 3D preview + exports
// ---------------------------------------------------------------------------
const preview3d = new Preview3D($('stage3d'));
$('v-color').addEventListener('input', (e) => preview3d.setColor(e.target.value));
$('fit3d').addEventListener('click', () => preview3d.fit());

// Inside a claude.ai artifact, files go through the platform's downloads
// capability (which does not accept .stl, so STL files are zipped there).
let hostDownloads;
function hostSaver() {
  if (hostDownloads === undefined) {
    hostDownloads = window.claude?.use ? window.claude.use('downloads').catch(() => null) : Promise.resolve(null);
  }
  return hostDownloads;
}

function flash(text, cls = '') {
  const el = $('toast');
  el.textContent = text;
  el.className = `toast ${cls}`;
  el.hidden = false;
  clearTimeout(flash.t);
  flash.t = setTimeout(() => (el.hidden = true), 3500);
}

async function deliver(files) {
  // files: [{ name, data, type }]
  const saver = await hostSaver();
  if (saver) {
    const direct = files.length === 1 && !/\.stl$/i.test(files[0].name);
    const name = direct ? files[0].name : `${baseName()}.zip`;
    const data = direct ? files[0].data : makeZip(files.map((f) => ({ name: f.name, data: f.data })));
    try {
      await saver.save({ filename: name, data: new Blob([data]) });
      flash(`Saved ${name}`, 'ok');
    } catch (err) {
      if (err?.code !== 'declined') flash(`Could not save: ${err?.message || err?.code || err}`, 'bad');
    }
    return;
  }
  for (const f of files) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([f.data], { type: f.type }));
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
}

function baseName() {
  return `${state.sourceName}-${state.s.frameShape}-${Math.round(state.s.width)}mm`;
}

function stlFiles({ withStand }) {
  const m = state.result3d;
  const files = [{ name: `${baseName()}.stl`, data: toBinarySTL(m.exportPiece(), baseName()), type: 'model/stl' }];
  const stand = withStand && m.exportStand();
  if (stand) files.push({ name: `${baseName()}-stand.stl`, data: toBinarySTL(stand, 'stand'), type: 'model/stl' });
  return files;
}

$('dl-stl').addEventListener('click', () => {
  if (state.result3d) deliver(stlFiles({ withStand: false }));
});
$('dl-stand').addEventListener('click', () => {
  if (!state.result3d?.stand) return;
  deliver(stlFiles({ withStand: true }).slice(1));
});
$('dl-svg').addEventListener('click', () => {
  if (!state.result2d) return;
  const r = state.result2d;
  const svg = toSVG(r.solidPolys, { title: baseName(), layers: r.layers.map((l) => l.polys) });
  deliver([{ name: `${baseName()}.svg`, data: svg, type: 'image/svg+xml' }]);
});

window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', draw2D);

// ---------------------------------------------------------------------------
buildControls();
updateTools();
getWasm();
useSource(sampleCanvas('tree'), 'tree');
