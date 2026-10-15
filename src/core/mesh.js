// Vector contours -> watertight 3D solids (via manifold-3d) -> STL.
//
// Model coordinates (mm): X right, Y up (art upright, base at y = 0),
// Z = thickness, back face at z = 0.

/**
 * Convert traced pixel loops into mm polygons (y up, origin at frame centre /
 * bottom of the piece).
 */
export function loopsToPolygons(loops, layout, yBottomMm) {
  return loops.map((loop) => {
    const pts = [];
    for (let i = 0; i < loop.length; i += 2) {
      const x = layout.minX + (loop[i] + 0.5) / layout.res;
      const y = layout.minY + (loop[i + 1] + 0.5) / layout.res;
      pts.push([x, yBottomMm - y]);
    }
    return pts;
  });
}

// Bottom-most solid pixel edge in mm (y down), used as the y = 0 baseline.
export function bottomMm(mask, layout) {
  for (let y = mask.h - 1; y >= 0; y--) {
    const row = y * mask.w;
    for (let x = 0; x < mask.w; x++) if (mask.data[row + x]) return layout.minY + (y + 1) / layout.res;
  }
  return 0;
}

const keep = (garbage, obj) => {
  garbage.push(obj);
  return obj;
};

/**
 * Build the printable piece.
 * @param wasm   initialised manifold module
 * @param p      { solidPolys, framePolys, artThickness, frameThickness,
 *                 foot: { width, height, depth, position } | null }
 * @returns { manifold, garbage } caller must delete garbage when done
 */
export function buildPiece(wasm, p) {
  const { CrossSection, Manifold } = wasm;
  const garbage = [];
  const cs = keep(garbage, new CrossSection(p.solidPolys, 'Positive'));
  let piece = keep(garbage, cs.extrude(p.artThickness));

  if (p.framePolys && p.framePolys.length && p.frameThickness > p.artThickness + 1e-6) {
    const fcs = keep(garbage, new CrossSection(p.framePolys, 'Positive'));
    const frame = keep(garbage, fcs.extrude(p.frameThickness));
    piece = keep(garbage, piece.add(frame));
  }

  for (const layer of p.layers || []) {
    if (!layer.polys.length) continue;
    const lcs = keep(garbage, new CrossSection(layer.polys, 'Positive'));
    piece = keep(garbage, piece.add(keep(garbage, lcs.extrude(layer.height))));
  }

  const slab = Math.max(p.artThickness, p.frameThickness || 0);
  if (p.foot && p.foot.depth > slab + 1e-6) {
    const { width, height, depth, position } = p.foot;
    const z0 = position === 'center' ? slab / 2 - depth / 2 : 0;
    const foot = keep(garbage, keep(garbage, Manifold.cube([width, height, depth])).translate([-width / 2, 0, z0]));
    piece = keep(garbage, piece.add(foot));
  }

  if (p.text && p.text.depth > 0.05) {
    const { polys, mode, depth, z } = p.text;
    const tcs = keep(garbage, new CrossSection(polys, 'Positive'));
    if (mode === 'emboss') {
      const t = keep(garbage, keep(garbage, tcs.extrude(depth)).translate([0, 0, z]));
      piece = keep(garbage, piece.add(t));
    } else {
      const t = keep(garbage, keep(garbage, tcs.extrude(depth + 1)).translate([0, 0, z - depth]));
      piece = keep(garbage, piece.subtract(t));
    }
  }
  return { manifold: piece, garbage };
}

/**
 * A separate desk stand with a slot the piece slides into.
 * Built in model coordinates (Y up, Z depth), centred under the piece.
 */
export function buildStand(wasm, s) {
  const { Manifold } = wasm;
  const garbage = [];
  const slotW = s.slab + s.clearance;
  const slotL = s.baseWidth + s.clearance * 2;
  const L = slotL + 2 * s.wall;
  const D = Math.max(s.depth, slotW + 2 * s.wall);
  const H = Math.max(s.height, s.slotDepth + 2);
  const box = (size, offset) => keep(garbage, keep(garbage, Manifold.cube(size)).translate(offset));
  const block = box([L, H, D], [-L / 2, -H + s.slotDepth, s.slab / 2 - D / 2]);
  const slot = box([slotL, s.slotDepth + 1, slotW], [-slotL / 2, 0, s.slab / 2 - slotW / 2]);
  let stand = keep(garbage, block.subtract(slot));
  if (s.chamfer > 0) {
    // Soften the long top edges with two wedge cuts.
    const c = Math.min(s.chamfer, (D - slotW) / 2 - 0.5, H / 2);
    if (c > 0.2) {
      for (const side of [-1, 1]) {
        const cube = keep(garbage, Manifold.cube([L + 2, c * Math.SQRT2, c * Math.SQRT2], true));
        const rotated = keep(garbage, cube.rotate([45, 0, 0]));
        const wedge = keep(garbage, rotated.translate([0, s.slotDepth, s.slab / 2 + (side * D) / 2]));
        stand = keep(garbage, stand.subtract(wedge));
      }
    }
  }
  return { manifold: stand, garbage };
}

export function freeAll(garbage) {
  for (const g of garbage) {
    try {
      g.delete();
    } catch {
      /* already freed */
    }
  }
  garbage.length = 0;
}

/**
 * Get plain triangle data out of a manifold, optionally re-oriented for
 * printing. orientation: 'flat' (lying on its back) | 'upright' (standing).
 */
export function extractMesh(manifold, orientation = 'flat') {
  let m = manifold;
  let tmp = null;
  if (orientation === 'upright') {
    tmp = manifold.rotate([90, 0, 0]); // (x, y, z) -> (x, -z, y)
    m = tmp;
  }
  const mesh = m.getMesh();
  const np = mesh.numProp;
  const n = mesh.vertProperties.length / np;
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    positions[3 * i] = mesh.vertProperties[np * i];
    positions[3 * i + 1] = mesh.vertProperties[np * i + 1];
    positions[3 * i + 2] = mesh.vertProperties[np * i + 2];
  }
  if (tmp) tmp.delete();
  // Drop onto the bed (z = 0) and centre in X/Y.
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = positions[3 * i], y = positions[3 * i + 1], z = positions[3 * i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  for (let i = 0; i < n; i++) {
    positions[3 * i] -= cx;
    positions[3 * i + 1] -= cy;
    positions[3 * i + 2] -= minZ;
  }
  return {
    positions,
    indices: Uint32Array.from(mesh.triVerts),
    size: [maxX - minX, maxY - minY, maxZ - minZ],
  };
}

/** Binary STL from indexed triangles. */
export function toBinarySTL({ positions, indices }, name = 'imgtostl') {
  const triCount = indices.length / 3;
  const buf = new ArrayBuffer(84 + triCount * 50);
  const dv = new DataView(buf);
  const header = `${name} - generated by Imgtostl`.slice(0, 80);
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i) & 0x7f);
  dv.setUint32(80, triCount, true);
  let o = 84;
  for (let t = 0; t < triCount; t++) {
    const a = indices[3 * t] * 3;
    const b = indices[3 * t + 1] * 3;
    const c = indices[3 * t + 2] * 3;
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    dv.setFloat32(o, nx, true);
    dv.setFloat32(o + 4, ny, true);
    dv.setFloat32(o + 8, nz, true);
    o += 12;
    for (const idx of [a, b, c]) {
      dv.setFloat32(o, positions[idx], true);
      dv.setFloat32(o + 4, positions[idx + 1], true);
      dv.setFloat32(o + 8, positions[idx + 2], true);
      o += 12;
    }
    dv.setUint16(o, 0, true);
    o += 2;
  }
  return buf;
}

/** SVG (mm units) from mm polygons with y up. */
export function toSVG(polys, { stroke = false, title = 'silhouette', layers = [] } = {}) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of polys) {
    for (const [x, y] of p) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!isFinite(minX)) return '<svg xmlns="http://www.w3.org/2000/svg"/>';
  const W = maxX - minX;
  const H = maxY - minY;
  const f = (v) => +v.toFixed(3);
  const pathData = (ps) => ps.map((p) => 'M' + p.map(([x, y]) => `${f(x - minX)} ${f(maxY - y)}`).join('L') + 'Z').join('');
  const d = pathData(polys);
  // Extra depth layers as separate groups (handy for layered laser cutting).
  const shades = ['#444', '#777', '#999'];
  const extra = layers
    .filter((ps) => ps.length)
    .map((ps, i) => `<g id="layer-${i + 2}"><path fill="${shades[i % 3]}" fill-rule="nonzero" d="${pathData(ps)}"/></g>\n`)
    .join('');
  const style = stroke
    ? 'fill="none" stroke="#000" stroke-width="0.1"'
    : 'fill="#000" fill-rule="nonzero"';
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${f(W)}mm" height="${f(H)}mm" viewBox="0 0 ${f(W)} ${f(H)}">\n` +
    `<title>${title}</title>\n<g id="layer-1"><path ${style} d="${d}"/></g>\n${extra}</svg>\n`
  );
}
