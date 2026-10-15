// Browser-side image handling: loading, placing the art on the layout canvas,
// auto-detection and built-in sample artwork.
import { inkField, otsu, borderMean } from './core/filters.js';

const MAX_SOURCE = 2048;

export function hexToRgb(hex) {
  const v = parseInt(hex.replace('#', ''), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Load a File/Blob into a canvas (downscaled to MAX_SOURCE). */
export async function loadImageFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Could not decode image'));
      i.src = url;
    });
    let w = img.naturalWidth || 512;
    let h = img.naturalHeight || 512;
    const k = Math.min(1, MAX_SOURCE / Math.max(w, h));
    // SVGs without intrinsic size: render at a decent resolution.
    if (/svg/.test(file.type) && Math.max(w, h) < 1024) {
      const up = 1024 / Math.max(w, h);
      w *= up;
      h *= up;
    } else {
      w *= k;
      h *= k;
    }
    const c = makeCanvas(Math.round(w), Math.round(h));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function inkOptions(s) {
  return { invert: s.invert, keyColor: hexToRgb(s.keyColor) };
}

/** Ink field of the source image alone (for auto threshold). */
function sourceInk(source, s) {
  const k = Math.min(1, 384 / Math.max(source.width, source.height));
  const w = Math.max(1, Math.round(source.width * k));
  const h = Math.max(1, Math.round(source.height * k));
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  return { field: inkField(data, w * h, s.mode, inkOptions(s)), data, w, h };
}

export function autoThreshold(source, s) {
  if (s.mode === 'alpha') return s.threshold;
  const { field, data } = sourceInk(source, s);
  // Only consider opaque pixels.
  const vals = [];
  for (let i = 0; i < field.length; i++) if (data[4 * i + 3] > 127) vals.push(field[i]);
  if (vals.length < 16) return 128;
  return Math.min(250, Math.max(5, otsu(Float32Array.from(vals))));
}

/** Guess good image settings for a freshly loaded image. */
export function detectSettings(source) {
  const k = Math.min(1, 256 / Math.max(source.width, source.height));
  const w = Math.max(1, Math.round(source.width * k));
  const h = Math.max(1, Math.round(source.height * k));
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 200) transparent++;
  if (transparent / (w * h) > 0.03) {
    return { mode: 'alpha', invert: false, threshold: 128 };
  }
  const base = { mode: 'luminance', invert: false };
  const field = inkField(data, w * h, 'luminance');
  const cut = otsu(field);
  // If the border is mostly "ink", the subject is light on a dark background.
  const invert = borderMean(field, w, h) > cut;
  return { ...base, invert, threshold: Math.round(invert ? 255 - cut : cut) };
}

/**
 * Draw the placed art onto a canvas the size of the layout and return its
 * ink field and RGBA pixels.
 */
export function renderPlacedArt(source, layout, s) {
  const c = makeCanvas(layout.w, layout.h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (source) {
    const box = layout.artBox;
    const fit = Math.min(box.w / source.width, box.h / source.height) * s.artScale; // mm per source px
    const cx = (s.offsetX - layout.minX) * layout.res;
    const cy = (s.offsetY - layout.minY) * layout.res;
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(cx, cy);
    ctx.rotate((s.rotation * Math.PI) / 180);
    ctx.scale((s.flipX ? -1 : 1) * fit * layout.res, fit * layout.res);
    ctx.drawImage(source, -source.width / 2, -source.height / 2);
  }
  const img = ctx.getImageData(0, 0, layout.w, layout.h);
  return { ink: inkField(img.data, layout.w * layout.h, s.mode, inkOptions(s)), rgba: img };
}

// ---------------------------------------------------------------------------
// Built-in samples (drawn procedurally, black on white).
// ---------------------------------------------------------------------------
export const SAMPLES = {
  tree: { label: 'Tree & moon', draw: drawTree },
  cat: { label: 'Cat & stars', draw: drawCat },
  mountains: { label: 'Mountains', draw: drawMountains },
};

export function sampleCanvas(name) {
  const c = makeCanvas(1000, 1000);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 1000, 1000);
  ctx.fillStyle = '#111';
  ctx.strokeStyle = '#111';
  ctx.lineCap = 'round';
  SAMPLES[name].draw(ctx);
  return c;
}

function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function bird(ctx, x, y, s) {
  ctx.beginPath();
  ctx.moveTo(x - s, y);
  ctx.quadraticCurveTo(x - s / 2, y - s * 0.6, x, y);
  ctx.quadraticCurveTo(x + s / 2, y - s * 0.6, x + s, y);
  ctx.quadraticCurveTo(x + s / 2, y - s * 0.25, x, y + s * 0.15);
  ctx.quadraticCurveTo(x - s / 2, y - s * 0.25, x - s, y);
  ctx.fill();
}

function drawTree(ctx) {
  const rand = rng(7);
  // hill
  ctx.beginPath();
  ctx.moveTo(0, 1000);
  ctx.quadraticCurveTo(500, 700, 1000, 1000);
  ctx.fill();
  // fractal tree
  const branch = (x, y, len, ang, wdt, depth) => {
    const x2 = x + Math.cos(ang) * len;
    const y2 = y + Math.sin(ang) * len;
    ctx.lineWidth = wdt;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    if (depth === 0) {
      ctx.beginPath();
      ctx.arc(x2, y2, 6 + rand() * 6, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    const n = 2 + (rand() > 0.6 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const spread = 0.35 + rand() * 0.35;
      const a = ang + (i - (n - 1) / 2) * spread + (rand() - 0.5) * 0.2;
      branch(x2, y2, len * (0.68 + rand() * 0.1), a, wdt * 0.68, depth - 1);
    }
  };
  branch(420, 860, 190, -Math.PI / 2 - 0.05, 46, 7);
  // moon
  ctx.beginPath();
  ctx.arc(770, 220, 95, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.arc(815, 190, 85, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  // birds
  bird(ctx, 700, 450, 30);
  bird(ctx, 780, 400, 22);
  bird(ctx, 640, 380, 18);
}

function drawCat(ctx) {
  // branch
  ctx.lineWidth = 34;
  ctx.beginPath();
  ctx.moveTo(-20, 760);
  ctx.quadraticCurveTo(500, 700, 1020, 800);
  ctx.stroke();
  // body
  ctx.beginPath();
  ctx.ellipse(470, 610, 150, 120, -0.15, 0, Math.PI * 2);
  ctx.fill();
  // head
  ctx.beginPath();
  ctx.arc(600, 450, 85, 0, Math.PI * 2);
  ctx.fill();
  // ears
  ctx.beginPath();
  ctx.moveTo(530, 410);
  ctx.lineTo(545, 300);
  ctx.lineTo(600, 375);
  ctx.closePath();
  ctx.moveTo(610, 372);
  ctx.lineTo(670, 290);
  ctx.lineTo(680, 400);
  ctx.closePath();
  ctx.fill();
  // tail hanging down
  ctx.lineWidth = 30;
  ctx.beginPath();
  ctx.moveTo(340, 650);
  ctx.bezierCurveTo(260, 760, 330, 860, 260, 940);
  ctx.stroke();
  // paws on the branch
  ctx.beginPath();
  ctx.ellipse(560, 720, 40, 22, 0, 0, Math.PI * 2);
  ctx.ellipse(420, 720, 40, 22, 0, 0, Math.PI * 2);
  ctx.fill();
  // eye cut-out with floating pupil (an island that must be bridged)
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.ellipse(635, 440, 18, 12, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#111';
  ctx.beginPath();
  ctx.ellipse(637, 440, 5, 9, 0, 0, Math.PI * 2);
  ctx.fill();
  // stars
  const star = (x, y, r) => {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const rr = i % 2 ? r * 0.45 : r;
      ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fill();
  };
  star(250, 230, 45);
  star(380, 140, 28);
  star(820, 260, 36);
  star(160, 420, 22);
  // crescent moon
  ctx.beginPath();
  ctx.arc(820, 520, 70, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(850, 500, 62, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#111';
}

function drawMountains(ctx) {
  // Three tones (far range, near range, trees) to show off layered depth.
  const rand = rng(3);
  const range = (base, spread, step, color) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, 1000);
    let x = 0;
    ctx.lineTo(0, base + rand() * spread);
    while (x < 1000) {
      x += step + rand() * step;
      ctx.lineTo(x, base + rand() * spread);
    }
    ctx.lineTo(1000, 1000);
    ctx.closePath();
    ctx.fill();
  };
  // sun behind the far range
  ctx.fillStyle = '#a8a8a8';
  ctx.beginPath();
  ctx.arc(720, 330, 90, 0, Math.PI * 2);
  ctx.fill();
  range(330, 260, 70, '#9a9a9a');
  range(560, 180, 90, '#5c5c5c');
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 880, 1000, 120);
  for (let i = 0; i < 11; i++) {
    const tx = 30 + i * 92 + rand() * 30;
    const th = 150 + rand() * 150;
    ctx.beginPath();
    ctx.moveTo(tx, 890 - th);
    ctx.lineTo(tx + th * 0.27, 900);
    ctx.lineTo(tx - th * 0.27, 900);
    ctx.closePath();
    ctx.fill();
  }
  bird(ctx, 330, 200, 26);
  bird(ctx, 410, 240, 18);
}

export const TEXT_FONTS = {
  sans: '"Arial Black", "Helvetica Neue", Arial, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  rounded: '"Arial Rounded MT Bold", "Varela Round", "Trebuchet MS", sans-serif',
  script: '"Brush Script MT", "Segoe Script", "Lucida Handwriting", cursive',
  mono: '"Courier New", Courier, monospace',
};

/**
 * Rasterise the foot text into a mask the size of the layout canvas,
 * scaled to fit the text box (height = textSize, width = foot width).
 */
export function renderTextMask(layout, s) {
  if (!layout.hasText) return null;
  const text = s.text.trim();
  const font = (px) => `${s.textBold ? 'bold ' : ''}${px}px ${TEXT_FONTS[s.textFont] || TEXT_FONTS.sans}`;
  const probe = makeCanvas(8, 8).getContext('2d');
  probe.font = font(100);
  const mt = probe.measureText(text);
  const asc = mt.actualBoundingBoxAscent || 72;
  const desc = mt.actualBoundingBoxDescent || 0;
  const left = mt.actualBoundingBoxLeft || 0;
  const right = mt.actualBoundingBoxRight || mt.width;
  const tb = layout.textBox;
  const k = Math.min((tb.h * layout.res) / (asc + desc), (tb.w * layout.res) / (left + right));
  const c = makeCanvas(layout.w, layout.h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.font = font(100 * k);
  ctx.fillStyle = '#000';
  const cx = (tb.cx - layout.minX) * layout.res;
  const cy = (tb.cy - layout.minY) * layout.res;
  ctx.fillText(text, cx - ((right - left) / 2) * k, cy + ((asc - desc) / 2) * k);
  const d = ctx.getImageData(0, 0, layout.w, layout.h).data;
  const m = { w: layout.w, h: layout.h, data: new Uint8Array(layout.w * layout.h) };
  for (let i = 0; i < m.data.length; i++) m.data[i] = d[4 * i + 3] > 127 ? 1 : 0;
  return m;
}
