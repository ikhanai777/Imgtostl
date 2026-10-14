// Mask -> vector contours (marching squares + smoothing + simplification).
//
// Contours are returned in pixel coordinates (y down) and are oriented so the
// solid region is on the LEFT when walking along them on screen. In a y-up
// coordinate system (after flipping y) outer boundaries are therefore
// counter-clockwise (positive area) and holes clockwise.

/**
 * Marching squares on a binary mask, sampling at pixel centres.
 * Diagonal-only contacts are kept apart (consistent with 4-connectivity).
 * @returns {Array<Float64Array>} closed loops as flat [x0,y0,x1,y1,...]
 */
export function marchingSquares(mask) {
  const { w, h, data } = mask;
  // Padded sampling: virtual pixel (-1..w, -1..h), outside = empty.
  const W = w + 2;
  const H = h + 2;
  const at = (x, y) => (x < 1 || y < 1 || x > w || y > h ? 0 : data[(y - 1) * w + (x - 1)]);
  // Edge keys: horizontal edge (x,y)->(x+1,y): 2*(y*W+x); vertical (x,y)->(x,y+1): 2*(y*W+x)+1
  const next = new Map();
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const tl = at(x, y);
      const tr = at(x + 1, y);
      const br = at(x + 1, y + 1);
      const bl = at(x, y + 1);
      const code = tl | (tr << 1) | (br << 2) | (bl << 3);
      if (code === 0 || code === 15) continue;
      // Clockwise edges T,R,B,L with (from, to) corners.
      const corners = [tl, tr, br, bl];
      const keys = [
        2 * (y * W + x), // T
        2 * (y * W + x + 1) + 1, // R
        2 * ((y + 1) * W + x), // B
        2 * (y * W + x) + 1, // L
      ];
      // Edge i spans corners[i] -> corners[(i+1)%4]:
      // T: tl->tr, R: tr->br, B: br->bl, L: bl->tl.
      for (let i = 0; i < 4; i++) {
        const from = corners[i];
        const to = corners[(i + 1) % 4];
        if (from === 0 && to === 1) {
          // "in" edge: pair with the next "out" edge clockwise.
          for (let k = 1; k < 4; k++) {
            const j = (i + k) % 4;
            if (corners[j] === 1 && corners[(j + 1) % 4] === 0) {
              next.set(keys[i], keys[j]);
              break;
            }
          }
        }
      }
    }
  }

  const loops = [];
  const visited = new Set();
  for (const startKey of next.keys()) {
    if (visited.has(startKey)) continue;
    const pts = [];
    let k = startKey;
    while (!visited.has(k)) {
      visited.add(k);
      const cell = k >> 1;
      const cx = cell % W;
      const cy = (cell - cx) / W;
      // Unpad: virtual coordinate (cx, cy) corresponds to pixel (cx-1, cy-1).
      if (k & 1) pts.push(cx - 1, cy - 1 + 0.5);
      else pts.push(cx - 1 + 0.5, cy - 1);
      k = next.get(k);
      if (k === undefined) break;
    }
    if (pts.length >= 6) loops.push(Float64Array.from(pts));
  }
  return loops;
}

// Signed area in screen coordinates (y down). Solid-on-left loops (outer
// boundaries) come out NEGATIVE here; holes positive.
export function signedArea(loop) {
  let a = 0;
  const n = loop.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    a += loop[2 * j] * loop[2 * i + 1] - loop[2 * i] * loop[2 * j + 1];
  }
  return a / 2;
}

// Taubin smoothing (shrink-free Laplacian) on a closed loop.
export function smoothLoop(loop, iterations, lambda = 0.5, mu = -0.53) {
  const n = loop.length / 2;
  if (n < 4 || iterations <= 0) return loop;
  let cur = Float64Array.from(loop);
  let tmp = new Float64Array(loop.length);
  for (let it = 0; it < iterations; it++) {
    for (const f of [lambda, mu]) {
      for (let i = 0; i < n; i++) {
        const p = (i + n - 1) % n;
        const q = (i + 1) % n;
        for (let c = 0; c < 2; c++) {
          const v = cur[2 * i + c];
          tmp[2 * i + c] = v + f * ((cur[2 * p + c] + cur[2 * q + c]) / 2 - v);
        }
      }
      [cur, tmp] = [tmp, cur];
    }
  }
  return cur;
}

// Ramer-Douglas-Peucker for a closed loop.
export function simplifyLoop(loop, epsilon) {
  const n = loop.length / 2;
  if (n < 8 || epsilon <= 0) return loop;
  // Split at point 0 and the point farthest from it.
  let far = 0;
  let best = -1;
  for (let i = 1; i < n; i++) {
    const dx = loop[2 * i] - loop[0];
    const dy = loop[2 * i + 1] - loop[1];
    const d = dx * dx + dy * dy;
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[far] = 1;
  const eps2 = epsilon * epsilon;
  const stack = [[0, far], [far, n]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const bi = b % n;
    const ax = loop[2 * a];
    const ay = loop[2 * a + 1];
    const bx = loop[2 * bi];
    const by = loop[2 * bi + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const px = loop[2 * i] - ax;
      const py = loop[2 * i + 1] - ay;
      let d;
      if (len2 === 0) d = px * px + py * py;
      else {
        const cross = px * dy - py * dx;
        d = (cross * cross) / len2;
      }
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > eps2 && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(loop[2 * i], loop[2 * i + 1]);
  return Float64Array.from(out);
}

/**
 * Full tracing pipeline.
 * @param mask
 * @param opts { smoothing: iterations, tolerance: px, minArea: px² }
 */
export function traceMask(mask, opts = {}) {
  const { smoothing = 2, tolerance = 0.4, minArea = 0.5 } = opts;
  const loops = [];
  for (const raw of marchingSquares(mask)) {
    if (Math.abs(signedArea(raw)) < minArea) continue;
    const smoothed = smoothLoop(raw, smoothing);
    const simple = simplifyLoop(smoothed, tolerance);
    if (simple.length >= 6) loops.push(simple);
  }
  return loops;
}
