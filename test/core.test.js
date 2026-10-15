import { describe, it, expect, beforeAll } from 'vitest';
import Module from 'manifold-3d';
import { createMask, components, dilate, erode, countSolid, drawCapsule } from '../src/core/mask.js';
import { marchingSquares, signedArea, traceMask } from '../src/core/trace.js';
import { connectIslands } from '../src/core/bridge.js';
import { computeLayout, shapeContains } from '../src/core/compose.js';
import { DEFAULTS, build2D, build3D } from '../src/core/pipeline.js';
import { otsu, inkField } from '../src/core/filters.js';
import { toBinarySTL, toSVG } from '../src/core/mesh.js';

function disk(w, h, cx, cy, r) {
  const m = createMask(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) m.data[y * w + x] = 1;
  return m;
}

describe('mask ops', () => {
  it('dilate/erode are roughly inverse on a disk', () => {
    const m = disk(60, 60, 30, 30, 15);
    const d = dilate(m, 3);
    const e = erode(d, 3);
    expect(Math.abs(countSolid(e) - countSolid(m))).toBeLessThan(10);
    expect(countSolid(d)).toBeGreaterThan(countSolid(m));
  });

  it('treats diagonal contact as disconnected', () => {
    const m = createMask(4, 4);
    m.data[0] = 1;
    m.data[5] = 1;
    expect(components(m).count).toBe(2);
  });
});

describe('tracing', () => {
  it('produces one outer loop and one hole for a ring, with correct orientation', () => {
    const outer = disk(50, 50, 25, 25, 20);
    const inner = disk(50, 50, 25, 25, 10);
    for (let i = 0; i < outer.data.length; i++) outer.data[i] &= inner.data[i] ^ 1;
    const loops = marchingSquares(outer);
    expect(loops.length).toBe(2);
    const areas = loops.map(signedArea).sort((a, b) => a - b);
    // outer negative (screen coords), hole positive
    expect(areas[0]).toBeLessThan(0);
    expect(areas[1]).toBeGreaterThan(0);
    const net = -(areas[0] + areas[1]);
    expect(Math.abs(net - countSolid(outer)) / countSolid(outer)).toBeLessThan(0.05);
  });

  it('keeps diagonal-touching pixels as separate loops', () => {
    const m = createMask(4, 4);
    m.data[1 * 4 + 1] = 1;
    m.data[2 * 4 + 2] = 1;
    expect(marchingSquares(m).length).toBe(2);
  });

  it('simplification keeps area', () => {
    const m = disk(200, 200, 100, 100, 80);
    const loops = traceMask(m, { smoothing: 3, tolerance: 0.3 });
    expect(loops.length).toBe(1);
    expect(Math.abs(-signedArea(loops[0]) - Math.PI * 80 * 80) / (Math.PI * 6400)).toBeLessThan(0.02);
    expect(loops[0].length / 2).toBeLessThan(400);
  });
});

describe('islands', () => {
  it('bridges a floating island to the anchor', () => {
    const w = 80, h = 40;
    const anchor = createMask(w, h);
    for (let y = 30; y < 40; y++) for (let x = 0; x < w; x++) anchor.data[y * w + x] = 1;
    const solid = disk(w, h, 40, 12, 6);
    for (let i = 0; i < solid.data.length; i++) solid.data[i] |= anchor.data[i];
    expect(components(solid).count).toBe(2);
    const r = connectIslands(solid, anchor, { mode: 'bridge', bridgeRadius: 1.5 });
    expect(r.bridges.length).toBe(1);
    expect(components(r.mask).count).toBe(1);
  });

  it('removes islands in remove mode', () => {
    const w = 50, h = 50;
    const anchor = createMask(w, h);
    drawCapsule(anchor, 0, 48, 49, 48, 1);
    const solid = disk(w, h, 20, 20, 5);
    for (let i = 0; i < solid.data.length; i++) solid.data[i] |= anchor.data[i];
    const r = connectIslands(solid, anchor, { mode: 'remove' });
    expect(components(r.mask).count).toBe(1);
    expect(r.removedCount).toBe(1);
  });
});

describe('frame shapes', () => {
  it('hexagon has a flat bottom', () => {
    const W = 100, H = (100 * Math.sqrt(3)) / 2;
    expect(shapeContains('hexagon', W, H, 0, 0, H / 2 - 0.1)).toBe(true);
    expect(shapeContains('hexagon', W, H, 0, 0, H / 2 + 0.1)).toBe(false);
    expect(shapeContains('hexagon', W, H, 0, 25 - 0.1, H / 2 - 0.1)).toBe(true);
  });
});

describe('filters', () => {
  it('otsu splits a bimodal field', () => {
    const f = new Float32Array(1000);
    for (let i = 0; i < 1000; i++) f[i] = i < 500 ? 20 : 220;
    const t = otsu(f);
    expect(t).toBeGreaterThan(20);
    expect(t).toBeLessThan(220);
  });
  it('treats transparent pixels as empty in luminance mode', () => {
    const rgba = new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 255]);
    const f = inkField(rgba, 2, 'luminance');
    expect(f[0]).toBe(0);
    expect(f[1]).toBe(255);
  });
});

describe('full pipeline', () => {
  let wasm;
  beforeAll(async () => {
    wasm = await Module();
    wasm.setup();
  });

  function scene(s) {
    const layout = computeLayout(s);
    const ink = new Float32Array(layout.w * layout.h);
    // a "moon" (floating) and a "tree trunk" touching the frame bottom
    for (let py = 0; py < layout.h; py++) {
      for (let px = 0; px < layout.w; px++) {
        const x = layout.pxToMmX(px);
        const y = layout.pxToMmY(py);
        const moon = (x - 15) ** 2 + (y + 20) ** 2 < 64 && (x - 19) ** 2 + (y + 22) ** 2 > 49;
        const trunk = Math.abs(x + 10) < 3 && y > -10;
        const bird = Math.abs(x + 20) < 3 && Math.abs(y + 25) < 1;
        if (moon || trunk || bird) ink[py * layout.w + px] = 255;
      }
    }
    return { layout, ink };
  }

  for (const frameShape of ['circle', 'rect', 'arch', 'hexagon', 'oval', 'octagon']) {
    it(`builds a single watertight piece (${frameShape})`, () => {
      const s = { ...DEFAULTS, frameShape, resolution: 4 };
      const { layout, ink } = scene(s);
      const r = build2D(s, layout, ink, 128);
      expect(r.stats.pieces).toBe(1);
      expect(r.stats.bridges).toBeGreaterThanOrEqual(2);
      const m = build3D(wasm, { ...s, stand: true, footDepth: 0 }, r);
      expect(m.info.status).toBe('NoError');
      expect(m.info.volume).toBeGreaterThan(1000);
      // flat bottom sits on y = 0
      expect(Math.abs(m.info.bbox.min[1])).toBeLessThan(0.3);
      expect(m.stand).not.toBeNull();
      const exp = m.exportPiece();
      const stl = toBinarySTL(exp);
      expect(stl.byteLength).toBe(84 + 50 * (exp.indices.length / 3));
      expect(toSVG(r.solidPolys)).toContain('<path');
      m.dispose();
    });
  }

  it('supports a deep integrated foot and upright export', () => {
    const s = { ...DEFAULTS, frameShape: 'circle', resolution: 4, footDepth: 20, orientation: 'upright' };
    const { layout, ink } = scene(s);
    const r = build2D(s, layout, ink, 128);
    const m = build3D(wasm, s, r);
    expect(m.info.status).toBe('NoError');
    const exp = m.exportPiece();
    // upright: z is the art height (~ diameter + base)
    expect(exp.size[2]).toBeGreaterThan(100);
    expect(exp.size[1]).toBeCloseTo(20, 0);
    m.dispose();
  });
});

describe('zip', () => {
  it('writes a valid stored zip', async () => {
    const { makeZip, crc32 } = await import('../src/core/zip.js');
    expect(crc32(new TextEncoder().encode('hello'))).toBe(0x3610a686);
    const z = makeZip([{ name: 'a.txt', data: 'hello' }, { name: 'b.bin', data: new Uint8Array([1, 2, 3]) }]);
    const dv = new DataView(z.buffer);
    expect(dv.getUint32(0, true)).toBe(0x04034b50);
    expect(dv.getUint32(z.length - 22, true)).toBe(0x06054b50);
    expect(dv.getUint16(z.length - 12, true)).toBe(2);
  });
});

describe('new features', () => {
  let wasm;
  beforeAll(async () => {
    wasm = await Module();
    wasm.setup();
  });

  function moonScene(s, shade = false) {
    const layout = computeLayout(s);
    const ink = new Float32Array(layout.w * layout.h);
    for (let py = 0; py < layout.h; py++) {
      for (let px = 0; px < layout.w; px++) {
        const x = layout.pxToMmX(px);
        const y = layout.pxToMmY(py);
        if ((x - 10) ** 2 + (y + 15) ** 2 < 100) ink[py * layout.w + px] = 255; // floating disc
        else if (shade && Math.abs(x + 15) < 12 && y > 0) ink[py * layout.w + px] = x < -15 ? 230 : 140; // two tones
      }
    }
    return { layout, ink };
  }

  it('a painted stroke replaces the auto bridge', () => {
    const s = { ...DEFAULTS, resolution: 4 };
    const { layout, ink } = moonScene(s);
    expect(build2D(s, layout, ink, 128).stats.bridges).toBe(1);
    const strokes = [{ mode: 'add', r: 1.5, points: [[10, -15], [10, -50]] }];
    const r = build2D(s, layout, ink, 128, { strokes });
    expect(r.stats.bridges).toBe(0);
    expect(r.stats.pieces).toBe(1);
  });

  it('erasing removes art', () => {
    const s = { ...DEFAULTS, resolution: 4 };
    const { layout, ink } = moonScene(s);
    const strokes = [{ mode: 'erase', r: 12, points: [[10, -15]] }];
    const r = build2D(s, layout, ink, 128, { strokes });
    expect(r.stats.bridges).toBe(0);
    expect(r.stats.islands).toBe(0);
  });

  it('layered depth stacks darker tones higher', () => {
    const s = { ...DEFAULTS, resolution: 4, layers: 3, layerStep: 1.5, stand: false };
    const { layout, ink } = moonScene(s, true);
    const flat = build2D({ ...s, layers: 1 }, layout, ink, 100);
    const r = build2D(s, layout, ink, 100);
    expect(r.stats.layers).toBeGreaterThan(1);
    const a = build3D(wasm, { ...s, layers: 1 }, flat);
    const b = build3D(wasm, s, r);
    expect(b.info.status).toBe('NoError');
    expect(b.info.volume).toBeGreaterThan(a.info.volume);
    expect(b.info.bbox.max[2]).toBeCloseTo(s.artThickness + (r.stats.layers - 1) * 1.5, 1);
    expect(r.stats.layers).toBe(3);
    expect(toSVG(r.solidPolys, { layers: r.layers.map((l) => l.polys) })).toContain('layer-2');
    a.dispose();
    b.dispose();
  });

  for (const textMode of ['engrave', 'emboss', 'cutout']) {
    it(`text on the foot: ${textMode}`, () => {
      const s = { ...DEFAULTS, resolution: 4, text: 'HI', textSize: 8, textMode, textDepth: 1 };
      const { layout, ink } = moonScene(s);
      expect(layout.baseHeight).toBeGreaterThanOrEqual(8 + 2 + s.slotDepth);
      // fake glyphs: two bars inside the text box
      const textMask = createMask(layout.w, layout.h);
      const tb = layout.textBox;
      for (const cx of [-5, 5]) {
        drawCapsule(textMask, layout.mmToPxX(cx), layout.mmToPxY(tb.cy - 3), layout.mmToPxX(cx), layout.mmToPxY(tb.cy + 3), 1.2 * s.resolution);
      }
      const r = build2D(s, layout, ink, 128, { textMask });
      expect(r.stats.pieces).toBe(1);
      const plain = build3D(wasm, { ...s, text: '' }, build2D({ ...s, text: '' }, layout, ink, 128));
      const m = build3D(wasm, s, r);
      expect(m.info.status).toBe('NoError');
      if (textMode === 'emboss') expect(m.info.volume).toBeGreaterThan(plain.info.volume);
      else expect(m.info.volume).toBeLessThan(plain.info.volume);
      if (textMode === 'emboss') expect(m.info.bbox.max[2]).toBeCloseTo(s.frameThickness + 1, 1);
      m.dispose();
      plain.dispose();
    });
  }
});

describe('tone clustering', () => {
  it('cuts between flat tones', async () => {
    const { toneCuts } = await import('../src/core/pipeline.js');
    const vals = [...Array(300).fill(100), ...Array(400).fill(160), ...Array(300).fill(240), 101, 238, 159];
    const cuts = toneCuts(vals, 3);
    expect(cuts.length).toBe(2);
    expect(cuts[0]).toBeGreaterThan(100);
    expect(cuts[0]).toBeLessThan(160);
    expect(cuts[1]).toBeGreaterThan(160);
    expect(cuts[1]).toBeLessThan(240);
  });
});
