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
 */
export function connectIslands(solid, anchor, opts) {
  const { mode = 'bridge', bridgeRadius = 2, minIslandArea = 0, maxIslands = 300 } = opts;
  const out = cloneMask(solid);
  const removed = createMask(solid.w, solid.h);
  const bridgeMask = createMask(solid.w, solid.h);
  const bridges = [];
  const { labels, count, areas } = components(solid, 1);
  const N = solid.data.length;

  // Which components are anchored?
  const anchored = new Uint8Array(count + 1);
  let anyAnchored = false;
  for (let i = 0; i < N; i++) {
    if (anchor.data[i] && labels[i]) {
      anchored[labels[i]] = 1;
      anyAnchored = true;
    }
  }
  if (!anyAnchored && count > 0) {
    // No frame: treat the biggest piece as the anchor.
    let best = 1;
    for (let l = 2; l <= count; l++) if (areas[l] > areas[best]) best = l;
    anchored[best] = 1;
  }

  let islands = [];
  for (let l = 1; l <= count; l++) if (!anchored[l]) islands.push(l);

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

  const result = {
    mask: out,
    removed,
    bridgeMask,
    bridges,
    islandCount: count - anchored.reduce((s, v) => s + v, 0),
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

    const label = labels[hit];
    const o = origin[hit];
    const x0 = o % w;
    const y0 = (o - x0) / w;
    const x1 = hit % w;
    const y1 = (hit - x1) / w;
    drawCapsule(out, x0, y0, x1, y1, bridgeRadius);
    drawCapsule(bridgeMask, x0, y0, x1, y1, bridgeRadius);
    bridges.push({ x0, y0, x1, y1 });

    // Merge island + bridge into the connected set.
    pending[label] = 0;
    remaining--;
    for (let i = 0; i < N; i++) {
      if (labels[i] === label || bridgeMask.data[i]) connected[i] = 1;
    }
    // A bridge can touch other pending islands on its way: absorb them.
    absorbTouching(out, connected, labels, pending, w, h, () => remaining--);
  }
  return result;
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
