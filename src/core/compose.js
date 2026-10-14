// Frame layout and composition of the final printable silhouette mask.
import { andNot, and, createMask, erode, or, open, dilate, removeSmallSolids, fillSmallHoles } from './mask.js';
import { connectIslands } from './bridge.js';

export const FRAME_SHAPES = ['circle', 'oval', 'rect', 'arch', 'hexagon', 'octagon', 'none'];

// Outer frame size in mm (width, height) for a given shape.
export function frameSize(s) {
  const W = s.width;
  switch (s.frameShape) {
    case 'circle':
      return [W, W];
    case 'hexagon':
      return [W, (W * Math.sqrt(3)) / 2];
    case 'octagon':
      return [W, W];
    default:
      return [W, s.height];
  }
}

// Point-in-shape test, (x, y) in mm relative to the frame centre, y down.
export function shapeContains(shape, W, H, cornerRadius, x, y) {
  const hw = W / 2;
  const hh = H / 2;
  switch (shape) {
    case 'circle':
    case 'oval':
      return (x * x) / (hw * hw) + (y * y) / (hh * hh) <= 1;
    case 'rect':
    case 'none': {
      const r = Math.max(0, Math.min(cornerRadius, hw, hh));
      const qx = Math.abs(x) - (hw - r);
      const qy = Math.abs(y) - (hh - r);
      if (qx > r || qy > r) return false;
      if (qx <= 0 || qy <= 0) return true;
      return qx * qx + qy * qy <= r * r;
    }
    case 'arch': {
      if (Math.abs(x) > hw || y > hh) return false;
      const cy = -hh + hw; // centre of the top semicircle
      if (y >= cy) return true;
      return x * x + (y - cy) * (y - cy) <= hw * hw;
    }
    case 'hexagon':
    case 'octagon': {
      // Regular polygon with a flat bottom (and top), fitted to width W.
      const n = shape === 'hexagon' ? 6 : 8;
      const R = shape === 'hexagon' ? hw : hw / Math.cos(Math.PI / n);
      const apothem = R * Math.cos(Math.PI / n);
      // Edge normals: flat bottom => normal angles at 90° + k*360/n.
      for (let k = 0; k < n; k++) {
        const a = Math.PI / 2 + (k * 2 * Math.PI) / n;
        if (x * Math.cos(a) + y * Math.sin(a) > apothem) return false;
      }
      return true;
    }
    default:
      return false;
  }
}

/**
 * Compute the pixel canvas that holds frame, base and art.
 */
export function computeLayout(s) {
  const res = s.resolution; // px per mm
  const [W, H] = frameSize(s);
  const hasFrame = s.frameShape !== 'none';
  const fw = hasFrame ? s.frameWidth : 0;
  const margin = s.breakout ? Math.max(W, H) * 0.25 : 0;
  const hasBase = s.baseStyle !== 'none' && s.baseHeight > 0;
  const baseBottom = hasBase ? H / 2 + s.baseHeight : H / 2;
  const minX = -Math.max(W / 2 + margin, hasBase ? s.baseWidth / 2 : 0) - 1 / res;
  const maxX = -minX;
  const minY = -H / 2 - margin - 1 / res;
  const maxY = Math.max(baseBottom, H / 2 + margin) + 1 / res;
  const w = Math.ceil((maxX - minX) * res) + 2;
  const h = Math.ceil((maxY - minY) * res) + 2;
  // Art box: inside the frame opening.
  const artW = Math.max(1, W - 2 * fw);
  const artH = Math.max(1, H - 2 * fw);
  return {
    res,
    w,
    h,
    minX,
    minY,
    frameW: W,
    frameH: H,
    frameWidth: fw,
    hasFrame,
    hasBase,
    baseTop: H / 2 - Math.max(fw, 1),
    baseBottom,
    artBox: { cx: 0, cy: 0, w: artW, h: artH },
    // pixel index -> mm (pixel centre)
    pxToMmX: (px) => minX + (px + 0.5) / res,
    pxToMmY: (py) => minY + (py + 0.5) / res,
    mmToPxX: (x) => (x - minX) * res - 0.5,
    mmToPxY: (y) => (y - minY) * res - 0.5,
  };
}

function rasterize(layout, test) {
  const m = createMask(layout.w, layout.h);
  for (let py = 0; py < layout.h; py++) {
    const y = layout.pxToMmY(py);
    for (let px = 0; px < layout.w; px++) {
      if (test(layout.pxToMmX(px), y)) m.data[py * layout.w + px] = 1;
    }
  }
  return m;
}

export function frameMasks(layout, s) {
  const { frameW: W, frameH: H, res } = layout;
  const outer = rasterize(layout, (x, y) => shapeContains(s.frameShape, W, H, s.cornerRadius, x, y));
  let inner;
  let ring;
  if (layout.hasFrame) {
    inner = erode(outer, layout.frameWidth * res);
    ring = andNot(outer, inner);
  } else {
    inner = outer;
    ring = createMask(layout.w, layout.h);
  }
  let base = createMask(layout.w, layout.h);
  if (layout.hasBase) {
    const bw = s.baseWidth / 2;
    base = rasterize(layout, (x, y) => Math.abs(x) <= bw && y >= layout.baseTop && y <= layout.baseBottom);
    // Never let the base intrude into the art opening.
    base = andNot(base, inner);
  }
  return { outer, inner, ring, base };
}

/**
 * Clean up the raw thresholded art mask (all sizes in mm).
 */
export function cleanArt(art, s) {
  const res = s.resolution;
  const pxArea = res * res;
  let m = art;
  if (s.despeckle > 0) m = removeSmallSolids(m, s.despeckle * pxArea);
  if (s.fillHoles > 0) m = fillSmallHoles(m, s.fillHoles * pxArea);
  if (s.lineWeight > 0) m = dilate(m, s.lineWeight * res);
  else if (s.lineWeight < 0) m = erode(m, -s.lineWeight * res);
  if (s.smoothArt > 0) m = open(m, s.smoothArt * res); // remove hairlines/spikes
  return m;
}

/**
 * Compose frame + art, then make everything one connected printable piece.
 */
export function composeSolid(layout, s, artMask) {
  const { outer, inner, ring, base } = frameMasks(layout, s);
  const anchor = or(ring, base);
  let art = s.breakout ? andNot(artMask, outer) : createMask(layout.w, layout.h);
  art = or(art, and(artMask, inner));
  if (s.breakout) art = or(art, and(artMask, ring)); // overlapping the ring is fine
  const raw = or(anchor, art);

  const res = s.resolution;
  const islands = connectIslands(raw, anchor, {
    mode: s.islandMode,
    bridgeRadius: Math.max(1, (s.bridgeWidth * res) / 2),
    minIslandArea: s.minIsland * res * res,
  });
  const solid = islands.mask;

  // Thin-feature analysis: anything that disappears under a morphological
  // opening of radius minFeature/2 is thinner than minFeature.
  let thin = createMask(layout.w, layout.h);
  if (s.minFeature > 0) thin = andNot(solid, open(solid, (s.minFeature * res) / 2));

  return { solid, anchor, ring, base, inner, outer, art, islands, thin };
}
