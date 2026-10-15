// Magic-wand background removal on RGBA pixels (no AI: colour flood fill).

function dist(d, i, c) {
  const dr = d[i] - c[0];
  const dg = d[i + 1] - c[1];
  const db = d[i + 2] - c[2];
  // Weighted RGB distance, a cheap stand-in for perceptual difference.
  return Math.sqrt(2 * dr * dr + 4 * dg * dg + 3 * db * db) / 3;
}

function flood(d, w, h, seeds, color, tol, out) {
  const stack = [];
  for (const i of seeds) {
    if (!out[i] && d[4 * i + 3] > 0 && dist(d, 4 * i, color) <= tol) {
      out[i] = 1;
      stack.push(i);
    }
  }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w;
    const y = (i - x) / w;
    const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    for (const j of nb) {
      if (j < 0 || out[j]) continue;
      if (d[4 * j + 3] === 0 || dist(d, 4 * j, color) <= tol) {
        out[j] = 1;
        stack.push(j);
      }
    }
  }
}

/**
 * Apply wand operations to a copy of the pixels; removed pixels become
 * transparent. ops: [{ x, y, tol } | { auto: true, tol }] (source pixels).
 * @returns Uint8ClampedArray
 */
export function applyWand(rgba, w, h, ops) {
  const d = new Uint8ClampedArray(rgba);
  for (const op of ops) {
    const out = new Uint8Array(w * h);
    if (op.auto) {
      // Start from the border, using its median colour as the background.
      const border = [];
      for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
      for (let y = 1; y < h - 1; y++) border.push(y * w, y * w + w - 1);
      const ch = [0, 1, 2].map((c) => border.map((i) => d[4 * i + c]).sort((a, b) => a - b)[border.length >> 1]);
      flood(d, w, h, border, ch, op.tol, out);
    } else {
      const x = Math.max(0, Math.min(w - 1, Math.round(op.x)));
      const y = Math.max(0, Math.min(h - 1, Math.round(op.y)));
      const i = y * w + x;
      flood(d, w, h, [i], [d[4 * i], d[4 * i + 1], d[4 * i + 2]], op.tol, out);
    }
    for (let i = 0; i < out.length; i++) if (out[i]) d[4 * i + 3] = 0;
  }
  return d;
}
