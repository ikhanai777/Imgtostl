// Pure image-field helpers (no DOM). Fields are Float32Array of 0..255 "ink".
import { createMask } from './mask.js';

export function luminance(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Convert RGBA pixels to an ink field (high = solid).
 * mode: 'luminance' | 'alpha' | 'color'
 */
export function inkField(rgba, n, mode, { invert = false, keyColor = [255, 255, 255] } = {}) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgba[4 * i];
    const g = rgba[4 * i + 1];
    const b = rgba[4 * i + 2];
    const a = rgba[4 * i + 3] / 255;
    let v;
    if (mode === 'alpha') {
      v = a * 255;
    } else if (mode === 'color') {
      const dr = r - keyColor[0];
      const dg = g - keyColor[1];
      const db = b - keyColor[2];
      v = Math.min(255, Math.sqrt(dr * dr + dg * dg + db * db) * 0.6);
      v *= a;
    } else {
      v = 255 - luminance(r, g, b);
      v *= a;
    }
    if (invert && mode !== 'alpha') v = 255 * a - v;
    else if (invert) v = 255 - v;
    out[i] = v;
  }
  return out;
}

// Otsu's method on a 0..255 field. Returns the optimal cut value.
export function otsu(field) {
  const hist = new Float64Array(256);
  for (let i = 0; i < field.length; i++) {
    hist[Math.max(0, Math.min(255, Math.round(field[i])))]++;
  }
  const total = field.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestT = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      bestT = t;
    }
  }
  return bestT + 0.5;
}

// Separable box blur, applied 3x (≈ gaussian). Radius in pixels (float ok).
export function blurField(field, w, h, radius) {
  if (radius <= 0.25) return field;
  const r = Math.max(1, Math.round(radius / Math.sqrt(3)));
  let src = Float32Array.from(field);
  let dst = new Float32Array(field.length);
  for (let pass = 0; pass < 3; pass++) {
    boxH(src, dst, w, h, r);
    boxV(dst, src, w, h, r);
  }
  return src;
}

function boxH(src, dst, w, h, r) {
  const norm = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + clamp(k, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      dst[row + x] = acc * norm;
      acc += src[row + clamp(x + r + 1, 0, w - 1)] - src[row + clamp(x - r, 0, w - 1)];
    }
  }
}

function boxV(src, dst, w, h, r) {
  const norm = 1 / (2 * r + 1);
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[clamp(k, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = acc * norm;
      acc += src[clamp(y + r + 1, 0, h - 1) * w + x] - src[clamp(y - r, 0, h - 1) * w + x];
    }
  }
}

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

export function thresholdField(field, w, h, cut) {
  const m = createMask(w, h);
  for (let i = 0; i < field.length; i++) m.data[i] = field[i] > cut ? 1 : 0;
  return m;
}

// Mean ink along the image border, used to guess whether to invert.
export function borderMean(field, w, h) {
  let s = 0;
  let n = 0;
  for (let x = 0; x < w; x++) {
    s += field[x] + field[(h - 1) * w + x];
    n += 2;
  }
  for (let y = 1; y < h - 1; y++) {
    s += field[y * w] + field[y * w + w - 1];
    n += 2;
  }
  return n ? s / n : 0;
}
