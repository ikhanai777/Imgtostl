// Frame layout and composition of the final printable silhouette mask.
import { andNot, and, createMask, drawCapsule, erode, or, open, dilate, removeSmallSolids, fillSmallHoles } from './mask.js';
import { connectIslands } from './bridge.js';

export const TEXT_MARGIN = 1.2; // mm of foot kept around text

export const FRAME_SHAPES = ['circle', 'oval', 'rect', 'arch', 'hexagon', 'octagon', 'heart', 'star', 'shield', 'scallop', 'custom', 'none'];

const STAR_RATIO = (1 + Math.cos(Math.PI / 5)) / (2 * Math.sin((2 * Math.PI) / 5)); // height / width

// Outer frame size in mm (width, height) for a given shape.
export function frameSize(s) {
  const W = s.width;
  switch (s.frameShape) {
    case 'circle':
      return [W, W];
    case 'hexagon':
      return [W, (W * Math.sqrt(3)) / 2];
    case 'octagon':
    case 'scallop':
      return [W, W];
    case 'star':
      return [W, W * STAR_RATIO];
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
    case 'heart': {
      // Classic implicit heart, point down, mapped onto the W x H box.
      const [u0, u1, v0, v1] = HEART_BOUNDS;
      const u = u0 + ((x + hw) / W) * (u1 - u0);
      const v = v1 - ((y + hh) / H) * (v1 - v0);
      return heartF(u, v) <= 0;
    }
    case 'star': {
      // Five-pointed star, one point up, the two lower points on the bottom.
      const R = hw / Math.sin((2 * Math.PI) / 5);
      const cy = -hh + R; // centre so the top point touches the top edge
      return inStar(x, y - cy, R, R * 0.45);
    }
    case 'shield': {
      // Flat top, straight sides, then curving in to a point at the bottom.
      if (Math.abs(x) > hw || y < -hh || y > hh) return false;
      const shoulder = -hh * 0.05;
      if (y <= shoulder) return true;
      const t = (y - shoulder) / (hh - shoulder);
      return Math.abs(x) <= hw * Math.pow(Math.max(0, 1 - t * t), 0.62);
    }
    case 'scallop': {
      const r = Math.hypot(x, y);
      const th = Math.atan2(y, x);
      const n = 18;
      return r <= hw * (0.9 + 0.1 * Math.abs(Math.cos((n * th) / 2)));
    }
    default:
      return false;
  }
}

function heartF(u, v) {
  const a = u * u + v * v - 1;
  return a * a * a - u * u * v * v * v;
}

// Bounding box of the implicit heart, found once by sampling.
const HEART_BOUNDS = (() => {
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let v = -1.6; v <= 1.6; v += 0.004) {
    for (let u = -1.6; u <= 1.6; u += 0.004) {
      if (heartF(u, v) <= 0) {
        if (u < u0) u0 = u;
        if (u > u1) u1 = u;
        if (v < v0) v0 = v;
        if (v > v1) v1 = v;
      }
    }
  }
  return [u0, u1, v0, v1];
})();

function inStar(x, y, R, r) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r : R;
    pts.push([Math.cos(a) * rr, Math.sin(a) * rr]);
  }
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
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
  // Text on the foot needs room: grow the foot to fit it.
  const hasText = hasBase && !!(s.text && s.text.trim());
  // With a slot stand the bottom of the foot is hidden in the slot, so the
  // text sits above that reserve.
  const standActive = hasBase && s.stand && !(s.footDepth > Math.max(s.artThickness, s.frameThickness));
  const textBlock = hasText ? s.textSize + 2 * TEXT_MARGIN : 0;
  const slotReserve = hasText && standActive ? s.slotDepth : 0;
  const baseHeight = hasBase ? Math.max(s.baseHeight, textBlock + slotReserve) : 0;
  const baseBottom = hasBase ? H / 2 + baseHeight : H / 2;
  const minX = -Math.max(W / 2 + margin, hasBase ? s.baseWidth / 2 : 0) - 1 / res;
  const maxX = -minX;
  // Hanging loop above the frame, or a reinforced hole through its top.
  let hanger = null;
  if (hasFrame && (s.hanger === 'loop' || s.hanger === 'hole')) {
    const holeR = s.hangerHole / 2;
    const outerR = holeR + s.hangerWall;
    const cy = s.hanger === 'loop' ? -H / 2 - holeR - 0.5 : -H / 2 + fw / 2;
    hanger = { type: s.hanger, cx: 0, cy, holeR, outerR };
  }
  const top = Math.min(-H / 2 - margin, hanger ? hanger.cy - hanger.outerR : Infinity);
  const minY = top - 1 / res;
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
    hasText,
    baseHeight,
    hanger,
    // Text box (mm, y down): centred in the part of the foot below the frame.
    slotDepthMax: hasText ? Math.max(1, baseHeight - textBlock) : baseHeight,
    textBox: { cx: 0, cy: H / 2 + (baseHeight - slotReserve) / 2, w: Math.max(1, (s.baseWidth || 0) - 2 * TEXT_MARGIN), h: s.textSize || 0 },
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

export function frameMasks(layout, s, customOuter = null) {
  const { frameW: W, frameH: H, res } = layout;
  const outer =
    s.frameShape === 'custom' && customOuter
      ? customOuter
      : rasterize(layout, (x, y) =>
          shapeContains(s.frameShape === 'custom' ? 'rect' : s.frameShape, W, H, s.cornerRadius, x, y),
        );
  let inner;
  let ring;
  if (layout.hasFrame) {
    inner = erode(outer, layout.frameWidth * res);
    ring = andNot(outer, inner);
    if (s.doubleRing) {
      // A second, thinner ring inside the first, joined by small tabs.
      const gap = Math.max(1, s.ringGap) * res;
      const fw2 = Math.max(0.8, layout.frameWidth * 0.6) * res;
      const ringOut = erode(inner, gap);
      const ringIn = erode(ringOut, fw2);
      const ring2 = andNot(ringOut, ringIn);
      const tabs = createMask(layout.w, layout.h);
      const cx = layout.mmToPxX(0);
      const cy = layout.mmToPxY(0);
      const far = (layout.w + layout.h) * 2;
      for (let k = 0; k < 4; k++) {
        const a = (k * Math.PI) / 2 + Math.PI / 4;
        drawCapsule(tabs, cx, cy, cx + Math.cos(a) * far, cy + Math.sin(a) * far, Math.max(1, fw2 * 0.6));
      }
      const gapBand = andNot(inner, ringOut);
      ring = or(or(ring, ring2), and(tabs, gapBand));
      inner = ringIn;
    }
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
  let boss = createMask(layout.w, layout.h);
  let hole = createMask(layout.w, layout.h);
  const hg = layout.hanger;
  if (hg) {
    const d2 = (x, y) => (x - hg.cx) ** 2 + (y - hg.cy) ** 2;
    boss = rasterize(layout, (x, y) => d2(x, y) <= hg.outerR ** 2);
    hole = rasterize(layout, (x, y) => d2(x, y) <= hg.holeR ** 2);
  }
  return { outer, inner, ring, base, boss, hole };
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
export function composeSolid(layout, s, artMask, extras = {}) {
  const { outer, inner, ring, base, boss, hole } = frameMasks(layout, s, extras.frameOuter);
  let anchor = or(or(ring, base), boss);
  let art = s.breakout ? andNot(artMask, outer) : createMask(layout.w, layout.h);
  art = or(art, and(artMask, inner));
  if (s.breakout) art = or(art, and(artMask, ring)); // overlapping the ring is fine
  if (extras.erase) art = andNot(art, extras.erase);
  // Hand-painted material is never clipped: the user put it there on purpose.
  if (extras.add) art = or(art, extras.add);
  let text = null;
  if (extras.text && layout.hasBase) {
    text = and(extras.text, base);
    if (s.textMode === 'cutout') anchor = andNot(anchor, text);
  }
  let raw = or(anchor, art);
  if (text && s.textMode === 'cutout') raw = andNot(raw, text);

  const res = s.resolution;
  const islands = connectIslands(raw, anchor, {
    style: s.bridgeStyle,
    center: { x: layout.mmToPxX(0), y: layout.mmToPxY(0) },
    mode: s.islandMode,
    bridgeRadius: Math.max(1, (s.bridgeWidth * res) / 2),
    minIslandArea: s.minIsland * res * res,
  });
  let solid = islands.mask;

  // Thin-feature analysis: anything that disappears under a morphological
  // opening of radius minFeature/2 is thinner than minFeature.
  const thinOf = (m) => (s.minFeature > 0 ? andNot(m, open(m, (s.minFeature * res) / 2)) : createMask(layout.w, layout.h));
  let thin = thinOf(solid);
  let thickened = createMask(layout.w, layout.h);
  if (s.fixThin && s.minFeature > 0) {
    // Grow only the too-thin parts; everything else keeps its exact shape.
    const grown = dilate(thin, s.minFeature * res * 0.45);
    thickened = andNot(grown, solid);
    solid = or(solid, grown);
  }
  // The hanger hole is cut last so nothing can fill it back in.
  solid = andNot(solid, hole);
  anchor = andNot(anchor, hole);
  if (s.fixThin) thin = thinOf(solid);

  return { solid, anchor, ring, base, inner, outer, art, islands, thin, thickened, text };
}

/**
 * Rasterise brush strokes (mm coordinates, y down, frame centre origin).
 * strokes: [{ mode: 'add' | 'erase', r: mm, points: [[x, y], ...] }]
 */
export function strokeMasks(layout, strokes = []) {
  const add = createMask(layout.w, layout.h);
  const erase = createMask(layout.w, layout.h);
  for (const st of strokes) {
    const target = st.mode === 'erase' ? erase : add;
    const r = Math.max(0.5, st.r * layout.res);
    const pts = st.points.map(([x, y]) => [layout.mmToPxX(x), layout.mmToPxY(y)]);
    if (pts.length === 1) pts.push(pts[0]);
    for (let i = 1; i < pts.length; i++) drawCapsule(target, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], r);
    // A later add re-paints over earlier erasing and vice versa.
    const other = st.mode === 'erase' ? add : erase;
    for (let i = 0; i < target.data.length; i++) if (target.data[i]) other.data[i] = 0;
  }
  return { add, erase };
}
