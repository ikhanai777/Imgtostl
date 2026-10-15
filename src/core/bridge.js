// Island detection and auto-bridging, so that every printed part is attached
// to the frame and nothing falls out when the piece stands up.
import { cloneMask, components, createMask, drawCapsule } from './mask.js';

/**
 * @param {object} solid     composite mask (frame + art)
 * @param {object} anchor    mask of pixels that are "connected by definition"
 *                           (the frame ring and base)
 * @param {object} opts
 *   mode:          'bridge' | 'remove' | 'keep'
 *   bridgeRadius:  bridge half-width in px
 *   minIslandArea: islands smaller than this (px²) are always dropped
 *   maxIslands:    safety cap on the number of bridges
 *   style:         'shortest' | 'up' (hang from above) | 'down' (prop from
 *                  below) | 'radial' (spoke out from the centre)
 *   center:        { x, y } px, centre for radial bridges
 */
export function connectIslands(solid, anchor, opts) {
  const { mode = 'bridge', bridgeRadius = 2, minIslandArea = 0, maxIslands = 300, style = 'shortest' } = opts;
  const out = cloneMask(solid);
  const removed = createMask(solid.w, solid.h);
  const bridgeMask = createMask(solid.w, solid.h);
  const bridges = [];
  const { labels, count, areas } = components(solid, 1);
  const N = solid.data.length;

  // The anchored piece is the one holding most of the frame. Any other piece
  // that holds frame (a second ring, a detached foot) is still floating, so
  // it is always bridged, whatever the island settings say.
  const anchored = new Uint8Array(count + 1);
  const overlap = new Float64Array(count + 1);
  for (let i = 0; i < N; i++) if (anchor.data[i] && labels[i]) overlap[labels[i]]++;
  let best = 0;
  for (let l = 1; l <= count; l++) if (overlap[l] > overlap[best]) best = l;
  if (!best && count > 0) {
    // No frame: treat the biggest piece as the anchor.
    best = 1;
    for (let l = 2; l <= count; l++) if (areas[l] > areas[best]) best = l;
  }
  if (best) anchored[best] = 1;
  const forced = [];
  for (let l = 1; l <= count; l++) if (!anchored[l] && overlap[l] > 0) forced.push(l);

  let islands = [];
  for (let l = 1; l <= count; l++) if (!anchored[l] && !overlap[l]) islands.push(l);

  const drop = (labelSet) => {
    for (let i = 0; i < N; i++) {
      if (labels[i] && labelSet.has(labels[i])) {
        out.data[i] = 0;
        removed.data[i] = 1;
      }
    }
  };

  // Tiny specks are never worth a bridge.
  const tiny = new Set(islands.filter((l) => areas[l] < minIslandArea));
  islands = islands.filter((l) => !tiny.has(l));
  if (mode === 'remove') {
    islands.forEach((l) => tiny.add(l));
    islands = [];
  } else if (mode === 'keep') {
    islands = [];
  }
  if (islands.length > maxIslands) {
    islands.sort((a, b) => areas[b] - areas[a]);
    islands.slice(maxIslands).forEach((l) => tiny.add(l));
    islands = islands.slice(0, maxIslands);
  }
  if (tiny.size) drop(tiny);
  islands = islands.concat(forced);

  const result = {
    mask: out,
    removed,
    bridgeMask,
    bridges,
    islandCount: count - anchored.reduce((s, v) => s + v, 0) - forced.length,
    removedCount: tiny.size,
  };
  if (!islands.length) return result;

  // Prim-style growth: repeatedly BFS outward from the connected set and
  // bridge the first island reached (i.e. the nearest one).
  const { w, h } = solid;
  const connected = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (labels[i] && anchored[labels[i]]) connected[i] = 1;
  const pending = new Uint8Array(count + 1);
  islands.forEach((l) => (pending[l] = 1));
  let remaining = islands.length;

  const origin = new Int32Array(N);
  const seen = new Uint32Array(N);
  const queue = new Int32Array(N);
  let stamp = 0;

  const attach = (label, x0, y0, x1, y1) => {
    drawCapsule(out, x0, y0, x1, y1, bridgeRadius);
    drawCapsule(bridgeMask, x0, y0, x1, y1, bridgeRadius);
    bridges.push({ x0, y0, x1, y1 });
    pending[label] = 0;
    remaining--;
    for (let i = 0; i < N; i++) {
      if (labels[i] === label || bridgeMask.data[i]) connected[i] = 1;
    }
    // A bridge can touch other pending islands on its way: absorb them.
    absorbTouching(out, connected, labels, pending, w, h, () => remaining--);
  };

  // Directional styles: cast a ray from each island and attach the island
  // whose ray is shortest; repeat (islands can hang from islands).
  const starts = style !== 'shortest' ? islandStarts(labels, count, w) : null;
  const dirFor = (l) => {
    if (style === 'up') return [0, -1];
    if (style === 'down') return [0, 1];
    const c = opts.center || { x: w / 2, y: h / 2 };
    const dx = starts[l].x - c.x;
    const dy = starts[l].y - c.y;
    const len = Math.hypot(dx, dy);
    return len < 1e-6 ? [0, -1] : [dx / len, dy / len];
  };
  const castRay = (l) => {
    const { x: sx, y: sy } = starts[l];
    const [dx, dy] = dirFor(l);
    let fromX = sx;
    let fromY = sy;
    for (let t = 0; t < w + h; t += 0.5) {
      const x = Math.round(sx + dx * t);
      const y = Math.round(sy + dy * t);
      if (x < 0 || y < 0 || x >= w || y >= h) return null;
      const i = y * w + x;
      if (labels[i] === l) {
        fromX = x;
        fromY = y;
      } else if (connected[i] && out.data[i]) {
        return { len: t, x0: fromX, y0: fromY, x1: x, y1: y };
      }
    }
    return null;
  };

  while (remaining > 0 && starts) {
    let bestRay = null;
    let bestLabel = 0;
    for (let l = 1; l <= count; l++) {
      if (!pending[l]) continue;
      const r = castRay(l);
      if (r && (!bestRay || r.len < bestRay.len)) {
        bestRay = r;
        bestLabel = l;
      }
    }
    if (!bestRay) break; // nothing in that direction: fall back to shortest
    attach(bestLabel, bestRay.x0, bestRay.y0, bestRay.x1, bestRay.y1);
  }

  while (remaining > 0) {
    stamp++;
    let qh = 0;
    let qt = 0;
    for (let i = 0; i < N; i++) {
      if (connected[i]) {
        // Only boundary pixels need seeding.
        const x = i % w;
        const y = (i - x) / w;
        if (
          (x > 0 && !connected[i - 1]) ||
          (x < w - 1 && !connected[i + 1]) ||
          (y > 0 && !connected[i - w]) ||
          (y < h - 1 && !connected[i + w])
        ) {
          queue[qt++] = i;
          origin[i] = i;
        }
        seen[i] = stamp;
      }
    }
    let hit = -1;
    while (qh < qt && hit < 0) {
      const i = queue[qh++];
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1 && hit < 0; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if ((dx === 0 && dy === 0) || nx < 0 || nx >= w) continue;
          const j = ny * w + nx;
          if (seen[j] === stamp) continue;
          seen[j] = stamp;
          origin[j] = origin[i];
          if (labels[j] && pending[labels[j]]) {
            hit = j;
            break;
          }
          queue[qt++] = j;
        }
      }
    }
    if (hit < 0) break; // unreachable (should not happen)

    const o = origin[hit];
    const x0 = o % w;
    const x1 = hit % w;
    attach(labels[hit], x0, (o - x0) / w, x1, (hit - x1) / w);
  }
  return result;
}

// Ray start per island: its centroid, or the island pixel nearest to it when
// the centroid falls outside (a crescent, a ring).
function islandStarts(labels, count, w) {
  const sx = new Float64Array(count + 1);
  const sy = new Float64Array(count + 1);
  const n = new Float64Array(count + 1);
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    if (!l) continue;
    sx[l] += i % w;
    sy[l] += Math.floor(i / w);
    n[l]++;
  }
  const out = [];
  const best = new Float64Array(count + 1).fill(Infinity);
  for (let l = 1; l <= count; l++) out[l] = { x: sx[l] / n[l], y: sy[l] / n[l], cx: sx[l] / n[l], cy: sy[l] / n[l] };
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    if (!l) continue;
    const x = i % w;
    const y = Math.floor(i / w);
    const d = (x - out[l].cx) ** 2 + (y - out[l].cy) ** 2;
    if (d < best[l]) {
      best[l] = d;
      out[l].x = x;
      out[l].y = y;
    }
  }
  return out;
}

function absorbTouching(mask, connected, labels, pending, w, h, onAbsorb) {
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < mask.data.length; i++) {
      const l = labels[i];
      if (!l || !pending[l]) continue;
      const x = i % w;
      const y = (i - x) / w;
      const touch =
        (x > 0 && connected[i - 1] && mask.data[i - 1]) ||
        (x < w - 1 && connected[i + 1] && mask.data[i + 1]) ||
        (y > 0 && connected[i - w] && mask.data[i - w]) ||
        (y < h - 1 && connected[i + w] && mask.data[i + w]);
      if (touch) {
        pending[l] = 0;
        onAbsorb();
        for (let j = 0; j < labels.length; j++) if (labels[j] === l) connected[j] = 1;
        changed = true;
      }
    }
  }
}
