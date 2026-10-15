// Ties the stages together. Everything here is DOM-free so it can be tested
// in Node and moved to a worker later.
import { blurField, thresholdField } from './filters.js';
import { cleanArt, composeSolid, strokeMasks } from './compose.js';
import { traceMask } from './trace.js';
import { bottomMm, buildPiece, buildStand, extractMesh, freeAll, loopsToPolygons } from './mesh.js';
import { and, andNot, components, countSolid, removeSmallSolids } from './mask.js';

export const DEFAULTS = {
  // image -> mask
  mode: 'luminance', // luminance | alpha | color
  invert: false,
  keyColor: '#ffffff',
  threshold: 128,
  autoThreshold: true,
  blur: 0.3, // mm
  despeckle: 2, // mm² - remove blobs smaller than this
  fillHoles: 1, // mm² - fill pinholes smaller than this
  lineWeight: 0, // mm, + thicken / - thin
  smoothArt: 0, // mm, opening radius
  // placement
  artScale: 1,
  offsetX: 0,
  offsetY: 0,
  rotation: 0,
  flipX: false,
  breakout: false,
  // frame
  frameShape: 'circle',
  width: 100,
  height: 120,
  frameWidth: 4,
  cornerRadius: 6,
  // base / standing
  baseStyle: 'foot', // none | foot
  baseWidth: 60,
  baseHeight: 6,
  footDepth: 0, // mm, 0 = same as slab
  footPosition: 'center', // center | front
  stand: true,
  standDepth: 30,
  standHeight: 12,
  slotDepth: 8,
  clearance: 0.3,
  // connectivity
  islandMode: 'bridge', // bridge | remove | keep
  bridgeWidth: 2,
  minIsland: 1, // mm²
  minFeature: 1.2, // mm
  // text on the foot
  text: '',
  textFont: 'sans',
  textBold: true,
  textSize: 7, // mm cap-to-baseline box height
  textMode: 'engrave', // engrave | emboss | cutout
  textDepth: 0.8, // mm
  // hanging
  hanger: 'none', // none | loop | hole
  hangerHole: 4, // mm
  hangerWall: 2.5, // mm
  // finishing
  bevel: 0.6, // mm chamfer on the front edges
  fixThin: false,
  pocketDiameter: 0, // mm, magnet/coin pocket under a deep foot (0 = off)
  pocketDepth: 3,
  printer: 'bambu-a1',
  // layered depth
  layers: 1,
  layerStep: 1.2, // mm per extra layer
  // 3D
  artThickness: 3,
  frameThickness: 4,
  orientation: 'flat', // flat | upright
  // vector
  smoothing: 3,
  tolerance: 0.05, // mm
  resolution: 6, // px / mm
};

/**
 * @param s       settings
 * @param layout  from computeLayout(s)
 * @param ink     Float32Array ink field over the layout canvas (0..255)
 * @param cut     threshold to apply
 */
export function build2D(s, layout, ink, cut, extras = {}) {
  const field = blurField(ink, layout.w, layout.h, s.blur * s.resolution);
  const rawArt = thresholdField(field, layout.w, layout.h, cut);
  const art = cleanArt(rawArt, s);
  const strokes = extras.strokes?.length ? strokeMasks(layout, extras.strokes) : {};
  const composed = composeSolid(layout, s, art, { ...strokes, text: extras.textMask });

  const tol = s.tolerance * s.resolution;
  const traceOpts = { smoothing: s.smoothing, tolerance: tol };
  const loops = traceMask(composed.solid, traceOpts);
  const raised = s.frameThickness > s.artThickness + 1e-6;
  const frameLoops = raised ? traceMask(composed.anchor, traceOpts) : [];

  const yBottom = bottomMm(composed.solid, layout);
  const solidPolys = loopsToPolygons(loops, layout, yBottom);
  const framePolys = loopsToPolygons(frameLoops, layout, yBottom);

  // Layered depth: darker tones stand taller. Each layer is nested inside the
  // one below it, so the stack always rests on the base silhouette.
  const layerMasks = depthLayers(s, field, cut, composed);
  const layers = layerMasks.map((m, i) => ({
    height: s.artThickness + (i + 1) * s.layerStep,
    loops: traceMask(m, traceOpts),
  }));
  layers.forEach((l) => (l.polys = loopsToPolygons(l.loops, layout, yBottom)));
  const levels = new Uint8Array(layout.w * layout.h);
  for (const m of layerMasks) for (let i = 0; i < levels.length; i++) levels[i] += m.data[i];

  const textLoops =
    composed.text && s.textMode !== 'cutout' ? traceMask(and(composed.text, composed.solid), traceOpts) : [];
  const textPolys = loopsToPolygons(textLoops, layout, yBottom);

  const pieces = components(composed.solid, 1).count;
  const thinPx = countSolid(composed.thin);
  return {
    layout,
    rawArt,
    art,
    composed,
    loops,
    solidPolys,
    framePolys,
    layers,
    levels,
    textPolys,
    yBottom,
    stats: {
      pieces,
      islands: composed.islands.islandCount,
      bridges: composed.islands.bridges.length,
      removed: composed.islands.removedCount,
      thinArea: thinPx / (s.resolution * s.resolution),
      thickenedArea: countSolid(composed.thickened) / (s.resolution * s.resolution),
      vertices: solidPolys.reduce((n, p) => n + p.length, 0),
      contours: solidPolys.length,
      layers: 1 + layers.filter((l) => l.polys.length).length,
    },
  };
}

// Split the art into nested tone bands. Tones are clustered (1D k-means on
// the ink histogram) so flat-coloured artwork splits exactly at its colours.
export function toneCuts(values, n) {
  const hist = new Float64Array(256);
  for (const v of values) hist[Math.max(0, Math.min(255, Math.round(v)))]++;
  const total = values.length;
  // Initialise centres at quantiles.
  const centers = [];
  let acc = 0;
  let q = 0;
  for (let t = 0; t < 256 && centers.length < n; t++) {
    acc += hist[t];
    while (centers.length < n && acc >= ((q + 0.5) / n) * total) {
      centers.push(t);
      q++;
    }
  }
  for (let iter = 0; iter < 30; iter++) {
    const sum = new Float64Array(n);
    const cnt = new Float64Array(n);
    for (let t = 0; t < 256; t++) {
      if (!hist[t]) continue;
      let best = 0;
      for (let k = 1; k < n; k++) if (Math.abs(t - centers[k]) < Math.abs(t - centers[best])) best = k;
      sum[best] += t * hist[t];
      cnt[best] += hist[t];
    }
    let moved = false;
    for (let k = 0; k < n; k++) {
      if (!cnt[k]) continue;
      const c = sum[k] / cnt[k];
      if (Math.abs(c - centers[k]) > 0.01) moved = true;
      centers[k] = c;
    }
    if (!moved) break;
  }
  const uniq = [...new Set(centers.map((c) => Math.round(c * 100) / 100))].sort((a, b) => a - b);
  const cuts = [];
  for (let k = 1; k < uniq.length; k++) if (uniq[k] - uniq[k - 1] > 8) cuts.push((uniq[k] + uniq[k - 1]) / 2);
  return cuts;
}

function depthLayers(s, field, cut, composed) {
  const n = Math.round(s.layers || 1);
  if (n < 2) return [];
  const artOnly = andNot(composed.solid, composed.anchor);
  const vals = [];
  const stride = Math.max(1, Math.floor(field.length / 200000));
  for (let i = 0; i < field.length; i += stride) if (artOnly.data[i] && field[i] > cut) vals.push(field[i]);
  if (vals.length < 10) return [];
  const out = [];
  const minArea = Math.max(4, s.despeckle * s.resolution * s.resolution);
  for (const c of toneCuts(vals, n)) {
    let m = thresholdField(field, composed.solid.w, composed.solid.h, c);
    m = removeSmallSolids(and(m, artOnly), minArea);
    if (out.length) m = and(m, out[out.length - 1]);
    out.push(m);
  }
  return out;
}

export function build3D(wasm, s, r) {
  const slab = Math.max(s.artThickness, r.framePolys.length ? s.frameThickness : 0);
  const foot =
    r.layout.hasBase && s.footDepth > slab
      ? { width: s.baseWidth, height: s.baseHeight, depth: s.footDepth, position: s.footPosition }
      : null;
  const baseH = r.layout.baseHeight;
  if (foot) foot.height = baseH;
  // Front face of the foot, where text sits.
  const footFront = foot
    ? (foot.position === 'center' ? slab / 2 - foot.depth / 2 : 0) + foot.depth
    : r.framePolys.length
      ? s.frameThickness
      : s.artThickness;
  const text =
    r.textPolys.length && s.textMode !== 'cutout'
      ? { polys: r.textPolys, mode: s.textMode, depth: Math.min(s.textDepth, footFront - 0.6), z: footFront }
      : null;
  const piece = buildPiece(wasm, {
    solidPolys: r.solidPolys,
    framePolys: r.framePolys,
    artThickness: s.artThickness,
    frameThickness: s.frameThickness,
    layers: r.layers,
    bevel: s.bevel,
    foot,
    pocket: { diameter: s.pocketDiameter, depth: s.pocketDepth },
    text,
  });
  let stand = null;
  if (s.stand && r.layout.hasBase && !foot) {
    stand = buildStand(wasm, {
      slab: Math.max(s.artThickness, s.frameThickness),
      clearance: s.clearance,
      baseWidth: s.baseWidth,
      wall: 4,
      depth: s.standDepth,
      height: s.standHeight,
      slotDepth: Math.min(s.slotDepth, r.layout.slotDepthMax),
      chamfer: 2,
    });
  }
  const m = piece.manifold;
  const info = {
    volume: m.volume(),
    genus: m.genus(),
    status: m.status(),
    triangles: m.numTri(),
    bbox: m.boundingBox(),
    standVolume: stand ? stand.manifold.volume() : 0,
    standBox: stand ? stand.manifold.boundingBox() : null,
  };
  return {
    piece,
    stand,
    info,
    previewMesh: extractMeshRaw(m),
    standMesh: stand ? extractMeshRaw(stand.manifold) : null,
    exportPiece: () => extractMesh(m, s.orientation),
    exportStand: () => (stand ? extractMesh(stand.manifold, 'upright') : null),
    dispose: () => {
      freeAll(piece.garbage);
      if (stand) freeAll(stand.garbage);
    },
  };
}

// Mesh in model coordinates (no re-orientation), for the 3D preview.
function extractMeshRaw(m) {
  const mesh = m.getMesh();
  const np = mesh.numProp;
  const n = mesh.vertProperties.length / np;
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    positions[3 * i] = mesh.vertProperties[np * i];
    positions[3 * i + 1] = mesh.vertProperties[np * i + 1];
    positions[3 * i + 2] = mesh.vertProperties[np * i + 2];
  }
  return { positions, indices: Uint32Array.from(mesh.triVerts) };
}
