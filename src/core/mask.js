// Binary mask utilities. A mask is { w, h, data: Uint8Array } where 1 = solid.

export function createMask(w, h) {
  return { w, h, data: new Uint8Array(w * h) };
}

export function cloneMask(m) {
  return { w: m.w, h: m.h, data: new Uint8Array(m.data) };
}

export function countSolid(m) {
  let n = 0;
  for (let i = 0; i < m.data.length; i++) n += m.data[i];
  return n;
}

export function or(a, b) {
  const out = createMask(a.w, a.h);
  for (let i = 0; i < out.data.length; i++) out.data[i] = a.data[i] | b.data[i];
  return out;
}

export function and(a, b) {
  const out = createMask(a.w, a.h);
  for (let i = 0; i < out.data.length; i++) out.data[i] = a.data[i] & b.data[i];
  return out;
}

export function andNot(a, b) {
  const out = createMask(a.w, a.h);
  for (let i = 0; i < out.data.length; i++) out.data[i] = a.data[i] & (b.data[i] ^ 1);
  return out;
}

export function invert(a) {
  const out = createMask(a.w, a.h);
  for (let i = 0; i < out.data.length; i++) out.data[i] = a.data[i] ^ 1;
  return out;
}

// ---------------------------------------------------------------------------
// Exact Euclidean distance transform (Felzenszwalb & Huttenlocher).
// Returns squared distance (in pixels²) from each pixel to the nearest pixel
// whose mask value equals `target`.
// ---------------------------------------------------------------------------
const INF = 1e20;

function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

export function sqDistanceTo(m, target) {
  const { w, h, data } = m;
  const grid = new Float64Array(w * h);
  for (let i = 0; i < grid.length; i++) grid[i] = data[i] === target ? 0 : INF;
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  // columns
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  // rows
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = grid[row + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) grid[row + x] = d[x];
  }
  return grid;
}

// Grow solid by radius r (pixels).
export function dilate(m, r) {
  if (r <= 0) return cloneMask(m);
  const dist = sqDistanceTo(m, 1);
  const out = createMask(m.w, m.h);
  const r2 = r * r;
  for (let i = 0; i < dist.length; i++) out.data[i] = dist[i] <= r2 ? 1 : 0;
  return out;
}

// Shrink solid by radius r (pixels). Pixels outside the image count as empty.
export function erode(m, r) {
  if (r <= 0) return cloneMask(m);
  const padded = pad(m, 1);
  const dist = sqDistanceTo(padded, 0);
  const out = createMask(m.w, m.h);
  const r2 = r * r;
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      out.data[y * m.w + x] = dist[(y + 1) * padded.w + x + 1] > r2 ? 1 : 0;
    }
  }
  return out;
}

export function open(m, r) {
  return dilate(erode(m, r), r);
}

export function close(m, r) {
  return erode(dilate(m, r), r);
}

export function pad(m, p) {
  const out = createMask(m.w + 2 * p, m.h + 2 * p);
  for (let y = 0; y < m.h; y++) {
    out.data.set(m.data.subarray(y * m.w, (y + 1) * m.w), (y + p) * out.w + p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Connected components. Solid uses 4-connectivity: two pixels touching only at
// a corner are NOT considered printable-connected.
// Returns { labels: Int32Array, count, areas: number[] } (label 0 = none).
// ---------------------------------------------------------------------------
export function components(m, value = 1, eight = false) {
  const { w, h, data } = m;
  const labels = new Int32Array(w * h);
  const areas = [0];
  const stack = new Int32Array(w * h);
  let count = 0;
  for (let start = 0; start < data.length; start++) {
    if (data[start] !== value || labels[start]) continue;
    count++;
    let area = 0;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = count;
    while (sp) {
      const i = stack[--sp];
      area++;
      const x = i % w;
      const y = (i - x) / w;
      const push = (j) => {
        if (data[j] === value && !labels[j]) {
          labels[j] = count;
          stack[sp++] = j;
        }
      };
      if (x > 0) push(i - 1);
      if (x < w - 1) push(i + 1);
      if (y > 0) push(i - w);
      if (y < h - 1) push(i + w);
      if (eight) {
        if (x > 0 && y > 0) push(i - w - 1);
        if (x < w - 1 && y > 0) push(i - w + 1);
        if (x > 0 && y < h - 1) push(i + w - 1);
        if (x < w - 1 && y < h - 1) push(i + w + 1);
      }
    }
    areas.push(area);
  }
  return { labels, count, areas };
}

// Remove solid specks smaller than minArea pixels.
export function removeSmallSolids(m, minArea) {
  if (minArea <= 0) return cloneMask(m);
  const { labels, areas } = components(m, 1);
  const out = cloneMask(m);
  for (let i = 0; i < out.data.length; i++) {
    if (labels[i] && areas[labels[i]] < minArea) out.data[i] = 0;
  }
  return out;
}

// Fill enclosed empty pockets smaller than minArea pixels. Empty regions that
// touch the image border are never filled.
export function fillSmallHoles(m, minArea) {
  if (minArea <= 0) return cloneMask(m);
  const { labels, areas, count } = components(m, 0, true);
  const touchesBorder = new Uint8Array(count + 1);
  const { w, h } = m;
  for (let x = 0; x < w; x++) {
    touchesBorder[labels[x]] = 1;
    touchesBorder[labels[(h - 1) * w + x]] = 1;
  }
  for (let y = 0; y < h; y++) {
    touchesBorder[labels[y * w]] = 1;
    touchesBorder[labels[y * w + w - 1]] = 1;
  }
  const out = cloneMask(m);
  for (let i = 0; i < out.data.length; i++) {
    const l = labels[i];
    if (l && !touchesBorder[l] && areas[l] < minArea) out.data[i] = 1;
  }
  return out;
}

// Rasterise a thick line segment (capsule) of radius r into the mask.
export function drawCapsule(m, x0, y0, x1, y1, r) {
  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - r - 1));
  const maxX = Math.min(m.w - 1, Math.ceil(Math.max(x0, x1) + r + 1));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - r - 1));
  const maxY = Math.min(m.h - 1, Math.ceil(Math.max(y0, y1) + r + 1));
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy || 1e-9;
  const r2 = r * r;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      let t = ((x - x0) * dx + (y - y0) * dy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = x0 + t * dx - x;
      const py = y0 + t * dy - y;
      if (px * px + py * py <= r2) m.data[y * m.w + x] = 1;
    }
  }
}
