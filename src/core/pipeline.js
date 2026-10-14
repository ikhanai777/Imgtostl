// Ties the stages together. Everything here is DOM-free so it can be tested
// in Node and moved to a worker later.
import { blurField, thresholdField } from './filters.js';
import { cleanArt, composeSolid } from './compose.js';
import { traceMask } from './trace.js';
import { bottomMm, buildPiece, buildStand, extractMesh, freeAll, loopsToPolygons } from './mesh.js';
import { components, countSolid } from './mask.js';

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
export function build2D(s, layout, ink, cut) {
  const field = blurField(ink, layout.w, layout.h, s.blur * s.resolution);
  const rawArt = thresholdField(field, layout.w, layout.h, cut);
  const art = cleanArt(rawArt, s);
  const composed = composeSolid(layout, s, art);

  const tol = s.tolerance * s.resolution;
  const loops = traceMask(composed.solid, { smoothing: s.smoothing, tolerance: tol });
  const raised = s.frameThickness > s.artThickness + 1e-6;
  const frameLoops = raised ? traceMask(composed.anchor, { smoothing: s.smoothing, tolerance: tol }) : [];

  const yBottom = bottomMm(composed.solid, layout);
  const solidPolys = loopsToPolygons(loops, layout, yBottom);
  const framePolys = loopsToPolygons(frameLoops, layout, yBottom);

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
    yBottom,
    stats: {
      pieces,
      islands: composed.islands.islandCount,
      bridges: composed.islands.bridges.length,
      removed: composed.islands.removedCount,
      thinArea: thinPx / (s.resolution * s.resolution),
      vertices: solidPolys.reduce((n, p) => n + p.length, 0),
      contours: solidPolys.length,
    },
  };
}

export function build3D(wasm, s, r) {
  const slab = Math.max(s.artThickness, r.framePolys.length ? s.frameThickness : 0);
  const foot =
    r.layout.hasBase && s.footDepth > slab
      ? { width: s.baseWidth, height: s.baseHeight, depth: s.footDepth, position: s.footPosition }
      : null;
  const piece = buildPiece(wasm, {
    solidPolys: r.solidPolys,
    framePolys: r.framePolys,
    artThickness: s.artThickness,
    frameThickness: s.frameThickness,
    foot,
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
      slotDepth: Math.min(s.slotDepth, s.baseHeight),
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
