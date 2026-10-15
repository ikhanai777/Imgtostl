// Every exported solid must weld into a closed 2-manifold: each edge shared by
// exactly two triangles once vertices are merged by position (as slicers do).
import { it, expect, beforeAll } from 'vitest';
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
