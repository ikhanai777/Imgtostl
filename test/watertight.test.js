// Every exported solid must weld into a closed 2-manifold: each edge shared by
// exactly two triangles once vertices are merged by position (as slicers do).
import { describe, it, expect, beforeAll } from 'vitest';
import Module from 'manifold-3d';
import { createMask, drawCapsule } from '../src/core/mask.js';
import { computeLayout } from '../src/core/compose.js';
import { DEFAULTS, build2D, build3D } from '../src/core/pipeline.js';

function badEdges({ positions, indices }) {
  const key = new Map();
  const id = (i) => {
    const k = `${positions[3 * i]},${positions[3 * i + 1]},${positions[3 * i + 2]}`;
    if (!key.has(k)) key.set(k, key.size);
    return key.get(k);
  };
  const edges = new Map();
  for (let t = 0; t < indices.length; t += 3) {
    const v = [id(indices[t]), id(indices[t + 1]), id(indices[t + 2])];
    for (let e = 0; e < 3; e++) {
      const a = v[e], b = v[(e + 1) % 3];
      const k = a < b ? `${a}-${b}` : `${b}-${a}`;
      edges.set(k, (edges.get(k) || 0) + 1);
    }
  }
  let bad = 0;
  for (const c of edges.values()) if (c !== 2) bad++;
  return bad;
}

let wasm;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

for (const textMode of ['engrave', 'emboss']) {
  it(`parts are clean solids (${textMode})`, () => {
    const s = { ...DEFAULTS, resolution: 5, colorMode: 'parts', text: 'HI', textMode, stand: false, hanger: 'hole' };
    const layout = computeLayout(s);
    const ink = new Float32Array(layout.w * layout.h);
    for (let py = 0; py < layout.h; py++)
      for (let px = 0; px < layout.w; px++) {
        const x = layout.pxToMmX(px), y = layout.pxToMmY(py);
        if (Math.abs(x) < 4 && y > -20) ink[py * layout.w + px] = 255;
        if ((x - 15) ** 2 + (y + 15) ** 2 < 36) ink[py * layout.w + px] = 255;
      }
    const textMask = createMask(layout.w, layout.h);
    const tb = layout.textBox;
    drawCapsule(textMask, layout.mmToPxX(-8), layout.mmToPxY(tb.cy), layout.mmToPxX(8), layout.mmToPxY(tb.cy), 1.5 * s.resolution);
    const m = build3D(wasm, s, build2D(s, layout, ink, 128, { textMask }));
    const parts = m.exportParts();
    expect(badEdges(m.exportPiece()), 'whole piece').toBe(0);
    for (const p of parts) expect(badEdges(p), p.name).toBe(0);
    const total = m.parts.reduce((a, p) => a + p.manifold.volume(), 0);
    const expected = m.info.volume + (textMode === 'engrave' ? m.parts[2].manifold.volume() : 0);
    expect(total).toBeCloseTo(expected, 0);
    m.dispose();
  });
}

const CONFIGS = {
  'depth layers + loop': { layers: 3, hanger: 'loop' },
  'deep foot + pocket + emboss': { footDepth: 20, pocketDiameter: 10, text: 'HI', textMode: 'emboss', stand: false },
  'raised frame + stand': { frameThickness: 6, stand: true },
  'double ring star': { frameShape: 'star', doubleRing: true },
  'no bevel, upright': { bevel: 0, orientation: 'upright' },
};
for (const [name, cfg] of Object.entries(CONFIGS)) {
  it(`welds cleanly: ${name}`, () => {
    const s = { ...DEFAULTS, resolution: 5, ...cfg };
    const layout = computeLayout(s);
    const ink = new Float32Array(layout.w * layout.h);
    for (let py = 0; py < layout.h; py++)
      for (let px = 0; px < layout.w; px++) {
        const x = layout.pxToMmX(px), y = layout.pxToMmY(py);
        if (Math.abs(x) < 6 && y > -15) ink[py * layout.w + px] = x < 0 ? 160 : 250; // two tones
        if ((x - 18) ** 2 + (y + 12) ** 2 < 30) ink[py * layout.w + px] = 250;
      }
    let textMask;
    if (s.text) {
      textMask = createMask(layout.w, layout.h);
      const tb = layout.textBox;
      drawCapsule(textMask, layout.mmToPxX(-6), layout.mmToPxY(tb.cy), layout.mmToPxX(6), layout.mmToPxY(tb.cy), 1.2 * s.resolution);
    }
    const m = build3D(wasm, s, build2D(s, layout, ink, 100, { textMask }));
    expect(m.info.status).toBe('NoError');
    expect(badEdges(m.exportPiece())).toBe(0);
    if (m.stand) expect(badEdges(m.exportStand())).toBe(0);
    m.dispose();
  });
}

import { STAND_TYPES, standDefaults } from '../src/core/stands.js';

for (const [type] of STAND_TYPES.filter(([t]) => t !== 'none')) {
  it(`functional base welds cleanly and fits the art: ${type}`, () => {
    const base = { ...DEFAULTS, resolution: 4, stand: true, standType: type };
    const s = { ...base, ...standDefaults(type, base.width, base.width + base.baseHeight), drainHole: true };
    const layout = computeLayout(s);
    const r = build2D(s, layout, new Float32Array(layout.w * layout.h), 128);
    const m = build3D(wasm, s, r);
    expect(m.stand, type).toBeTruthy();
    expect(m.stand.manifold.status()).toBe('NoError');
    expect(m.stand.manifold.genus()).toBeGreaterThanOrEqual(0);
    expect(badEdges(m.exportStand()), type).toBe(0);
    // The art's foot must fit the slot without colliding with the base.
    const clash = m.piece.manifold.intersect(m.stand.manifold);
    expect(clash.volume(), type).toBeLessThan(0.01);
    clash.delete();
    // ...and actually sit in it: the slot floor is right under the piece.
    const sb = m.stand.manifold.boundingBox();
    expect(sb.max[1]).toBeGreaterThan(0);
    if (type !== 'block') {
      expect(m.standProps.type).toBe(type);
    }
    if (type === 'pencil' || type === 'organizer') expect(m.standProps.cavities.length).toBeGreaterThanOrEqual(1);
    if (type === 'organizer') expect(m.standProps.cavities.length).toBe(4); // 3 compartments + front tray
    if (type === 'candle') {
      // The tealight sits behind the art with a clear gap.
      expect(m.standProps.candle.z + m.standProps.candle.r).toBeLessThan(-s.candleGap + 1);
    }
    m.dispose();
  });
}

describe('lantern', () => {
  for (const cfg of [{ lanternRepeats: 3 }, { lanternRepeats: 1, lanternPosts: false }, { lanternRepeats: 4, layers: 2, lanternHandle: false }]) {
    it(`bends into a clean one-piece lantern ${JSON.stringify(cfg)}`, () => {
      const s = { ...DEFAULTS, resolution: 4, product: 'lantern', ...cfg };
      const layout = computeLayout(s);
      expect(layout.artCells.length).toBe(s.lanternRepeats);
      const ink = new Float32Array(layout.w * layout.h);
      for (let py = 0; py < layout.h; py++)
        for (let px = 0; px < layout.w; px++) {
          const x = layout.pxToMmX(px), y = layout.pxToMmY(py);
          // a tree trunk in each cell + a floating star
          for (const c of layout.artCells) {
            if (Math.abs(x - c.cx) < 3 && y > 0) ink[py * layout.w + px] = 150;
            if ((x - c.cx - 10) ** 2 + (y + 25) ** 2 < 16) ink[py * layout.w + px] = 250;
          }
        }
      const r = build2D(s, layout, ink, 100);
      expect(r.stats.pieces).toBe(1);
      expect(r.stats.openingTop).toBeGreaterThan(5);
      const m = build3D(wasm, s, r);
      expect(m.info.status).toBe('NoError');
      expect(m.info.genus).toBeGreaterThan(0); // openings make it a high-genus solid
      const bb = m.info.bbox;
      expect(bb.max[0] - bb.min[0]).toBeCloseTo(s.lanternDiameter, 0);
      expect(bb.max[1] - bb.min[1]).toBeCloseTo(s.lanternHeight, 0);
      const exp = m.exportPiece();
      expect(badEdges(exp)).toBe(0);
      expect(exp.size[2]).toBeCloseTo(s.lanternHeight, 0); // stands on its floor
      expect(m.standProps.candle).toBeTruthy();
      m.dispose();
    });
  }
});

it('cut-out lantern: solid wall with the picture as openings', () => {
  const base = { ...DEFAULTS, resolution: 4, product: 'lantern', lanternRepeats: 3 };
  const layout = computeLayout(base);
  const ink = new Float32Array(layout.w * layout.h);
  for (let py = 0; py < layout.h; py++)
    for (let px = 0; px < layout.w; px++) {
      const x = layout.pxToMmX(px), y = layout.pxToMmY(py);
      for (const c of layout.artCells) if ((x - c.cx) ** 2 + y ** 2 < 144) ink[py * layout.w + px] = 255; // a 24 mm moon
    }
  const sil = build2D({ ...base, lanternStyle: 'silhouette' }, layout, ink, 128);
  const cut = build2D({ ...base, lanternStyle: 'cutout' }, layout, ink, 128);
  // The cut-out wall has far more material and only moon-sized openings.
  expect(cut.stats.openingTop).toBeLessThan(sil.stats.openingTop);
  expect(cut.stats.pieces).toBe(1);
  const m = build3D(wasm, { ...base, lanternStyle: 'cutout' }, cut);
  expect(m.info.status).toBe('NoError');
  expect(badEdges(m.exportPiece())).toBe(0);
  m.dispose();
});
