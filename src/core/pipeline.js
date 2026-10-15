// Ties the stages together. Everything here is DOM-free so it can be tested
// in Node and moved to a worker later.
import { blurField, thresholdField } from './filters.js';
import { cleanArt, composeSolid, strokeMasks } from './compose.js';
import { traceMask } from './trace.js';
import { bottomMm, buildPiece, extractMesh, extractParts, freeAll, loopsToPolygons } from './mesh.js';
import { buildFunctionalStand } from './stands.js';
import { buildLantern, widestOpeningTop } from './lantern.js';
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
  standType: 'block', // see STAND_TYPES
  standDepth: 30,
  standHeight: 12,
  standWall: 2.4, // mm, walls of cups and trays
  containerWidth: 70,
  containerDepth: 55,
  containerHeight: 80,
  compartments: 3,
  trayDepth: 35,
  candleDiameter: 39.5, // standard tealight cup is 38-39 mm
  candleGap: 25, // mm between the art and the tealight
  candleLift: 15,
  drainHole: false,
  bookendDepth: 110,
  slotDepth: 8,
  clearance: 0.3,
  // connectivity
  islandMode: 'bridge', // bridge | remove | keep
  bridgeWidth: 2,
  bridgeStyle: 'shortest', // shortest | up | down | radial
  minIsland: 1, // mm²
  minFeature: 1.2, // mm
  // text on the foot
  text: '',
  textFont: 'sans',
  textBold: true,
  textSize: 7, // mm cap-to-baseline box height
  textMode: 'engrave', // engrave | emboss | cutout
  textDepth: 0.8, // mm
  // frame extras
  doubleRing: false,
  ringGap: 2.5, // mm
  // colour
  colorMode: 'single', // single | parts | height
  // background removal
  wandTolerance: 40,
  // what to make
  product: 'frame', // frame | lantern
  lanternDiameter: 80,
  lanternHeight: 100,
  lanternWall: 2,
  lanternRepeats: 3,
  lanternBand: 7,
  lanternPost: 4,
  lanternPosts: true,
  lanternHandle: true,
  lanternStyle: 'cutout', // cutout (light through the picture) | silhouette
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
  const composed = composeSolid(layout, s, art, { ...strokes, text: extras.textMask, frameOuter: extras.frameOuter });

  const tol = s.tolerance * s.resolution;
  const traceOpts = { smoothing: s.smoothing, tolerance: tol };
  const loops = traceMask(composed.solid, traceOpts);
  const raised = s.frameThickness > s.artThickness + 1e-6;
  const frameLoops = raised || s.colorMode === 'parts' ? traceMask(composed.anchor, traceOpts) : [];

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
      openingTop: layout.lantern ? widestOpeningTop(composed.solid, layout) : 0,
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
  if (r.layout.lantern) return buildLantern3D(wasm, s, r);
  const raised = s.frameThickness > s.artThickness + 1e-6;
  const slab = Math.max(s.artThickness, raised ? s.frameThickness : 0);
  const foot =
    r.layout.hasBase && s.footDepth > slab
      ? { width: s.baseWidth, height: s.baseHeight, depth: s.footDepth, position: s.footPosition }
      : null;
  const baseH = r.layout.baseHeight;
  if (foot) foot.height = baseH;
  // Front face of the foot, where text sits.
  const footFront = foot
    ? (foot.position === 'center' ? slab / 2 - foot.depth / 2 : 0) + foot.depth
    : raised
      ? s.frameThickness
      : s.artThickness;
  const text =
    r.textPolys.length && s.textMode !== 'cutout'
      ? { polys: r.textPolys, mode: s.textMode, depth: Math.min(s.textDepth, footFront - 0.6), z: footFront }
      : null;
  const piece = buildPiece(wasm, {
    solidPolys: r.solidPolys,
    framePolys: raised ? r.framePolys : [],
    artThickness: s.artThickness,
    frameThickness: s.frameThickness,
    layers: r.layers,
    bevel: s.bevel,
    foot,
    pocket: { diameter: s.pocketDiameter, depth: s.pocketDepth },
    text,
  });
  let stand = null;
  const standType = s.stand ? s.standType || 'block' : 'none';
  if (standType !== 'none' && r.layout.hasBase && !foot) {
    stand = buildFunctionalStand(wasm, {
      type: standType,
      slab: Math.max(s.artThickness, s.frameThickness),
      clearance: s.clearance,
      baseWidth: s.baseWidth,
      wall: s.standWall,
      depth: s.standDepth,
      height: s.standHeight,
      slotDepth: Math.min(s.slotDepth, r.layout.slotDepthMax),
      containerWidth: s.containerWidth,
      containerDepth: s.containerDepth,
      containerHeight: s.containerHeight,
      compartments: s.compartments,
      trayDepth: s.trayDepth,
      candleDiameter: s.candleDiameter,
      candleGap: s.candleGap,
      candleLift: s.candleLift,
      drainHole: s.drainHole,
      bookendDepth: s.bookendDepth,
    });
  }
  const m = piece.manifold;
  const parts = s.colorMode === 'parts' ? splitParts(wasm, piece, r, text) : null;
  // Single-nozzle colour changes: every distinct top height but the highest.
  const tops = new Set([s.artThickness]);
  if (raised) tops.add(s.frameThickness);
  for (const l of r.layers) if (l.polys.length) tops.add(l.height);
  if (text && text.mode === 'emboss') tops.add(text.z + text.depth);
  const sortedTops = [...tops].map((v) => Math.round(v * 100) / 100).sort((a, b) => a - b);
  const colorChanges = s.orientation === 'flat' && !foot ? sortedTops.slice(0, -1) : [];
  const info = {
    colorChanges,
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
    standProps: stand ? stand.props || { type: 'block' } : null,
    parts,
    partMeshes: parts ? parts.map((p) => ({ ...extractMeshRaw(p.manifold), name: p.name, color: p.color })) : null,
    exportPiece: () => extractMesh(m, s.orientation),
    exportParts: () => (parts ? extractParts(parts, s.orientation) : null),
    exportStand: () => (stand ? extractMesh(stand.manifold, 'upright') : null),
    dispose: () => {
      if (parts) freeAll(parts.garbage);
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

/**
 * Split the finished piece into colour parts with exact booleans, so parts
 * neither overlap nor leave gaps: frame + foot, art, and text (raised letters,
 * or an inlay that fills engraved letters).
 */
function splitParts(wasm, piece, r, text) {
  const { CrossSection } = wasm;
  const garbage = [];
  const keep = (o) => (garbage.push(o), o);
  const P = piece.manifold;
  // Splitting prisms are grown slightly outward: where a split boundary would
  // run along the piece's own outer edge it then lies outside the piece
  // instead of grazing it, which would leave hairline slivers. The colour
  // seam moves 0.3 mm into the art, which is invisible.
  const GROW = 0.3;
  const grown = (polys) => keep(keep(new CrossSection(polys, 'Positive')).offset(GROW, 'Round'));
  const tall = (polys) => keep(keep(grown(polys).extrude(2000)).translate([0, 0, -1000]));
  const out = [];
  let frame = null;
  if (r.framePolys.length) {
    const F = tall(r.framePolys);
    frame = keep(P.intersect(F));
    out.push({ name: 'Art', color: 1, manifold: keep(P.subtract(F)) });
  } else {
    out.push({ name: 'Art', color: 1, manifold: P });
  }
  if (text && r.textPolys.length) {
    const tcs = keep(new CrossSection(r.textPolys, 'Positive'));
    if (text.mode === 'emboss') {
      // Raised letters: everything above the foot's face inside the letters.
      const T = keep(keep(grown(r.textPolys).extrude(text.depth + 1)).translate([0, 0, text.z]));
      const letters = keep(P.intersect(T));
      if (frame) frame = keep(frame.subtract(T));
      out.push({ name: 'Text', color: 3, manifold: letters });
    } else {
      // Inlay: exactly the material the engraving removed.
      const inlay = keep(keep(tcs.extrude(text.depth)).translate([0, 0, text.z - text.depth]));
      out.push({ name: 'Text', color: 3, manifold: inlay });
    }
  }
  if (frame) out.unshift({ name: 'Frame', color: 2, manifold: frame });
  const parts = out.filter((p) => !p.manifold.isEmpty());
  parts.garbage = garbage;
  return parts;
}

function buildLantern3D(wasm, s, r) {
  const lan = buildLantern(wasm, r.layout.lantern, {
    solidPolys: r.solidPolys,
    layers: r.layers,
    artThickness: s.artThickness,
    candleDiameter: s.candleDiameter,
    candleLift: s.candleLift,
    floor: 2.4,
  });
  const m = lan.manifold;
  return {
    piece: lan,
    stand: null,
    parts: null,
    partMeshes: null,
    info: {
      colorChanges: [],
      volume: m.volume(),
      genus: m.genus(),
      status: m.status(),
      triangles: m.numTri(),
      bbox: m.boundingBox(),
      standVolume: 0,
      standBox: null,
    },
    previewMesh: extractMeshRaw(m),
    standMesh: null,
    standProps: lan.props,
    // Lanterns always print standing on their floor.
    exportPiece: () => extractMesh(m, 'upright'),
    exportParts: () => null,
    exportStand: () => null,
    dispose: () => freeAll(lan.garbage),
  };
}
