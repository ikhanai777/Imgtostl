// Lantern: bend the flat wall design into a cylinder and give it a floor with
// a raised tealight pocket. Printed standing up, in one piece.
import { components } from './mask.js';
import { extrudeBevelled } from './mesh.js';

/**
 * @param wasm  manifold module
 * @param g     lanternGeometry(s)
 * @param p     { solidPolys, layers, candleDiameter, candleLift, floor }
 */
export function buildLantern(wasm, g, p) {
  const { CrossSection, Manifold } = wasm;
  const garbage = [];
  const keep = (o) => (garbage.push(o), o);

  // Flat wall: x along the circumference, y up, z = 0 inside .. t outside.
  let wall = extrudeBevelled(wasm, garbage, keep(new CrossSection(p.solidPolys, 'Positive')), g.t, 0);
  for (const layer of p.layers || []) {
    if (!layer.polys.length) continue;
    const lcs = keep(new CrossSection(layer.polys, 'Positive'));
    // Depth layers stand out from the wall's outer face.
    wall = keep(wall.add(keep(lcs.extrude(g.t + (layer.height - p.artThickness)))));
  }
  // Short edges so the bend is smooth, then wrap x onto the circle.
  const Ri = g.D / 2 - g.t;
  const fine = keep(wall.refineToLength(Math.max(0.8, Math.min(2, g.Rm / 25))));
  const bent = keep(
    fine.warp((v) => {
      const theta = v[0] / g.Rm;
      const r = Ri + v[2];
      v[0] = r * Math.sin(theta);
      v[2] = r * Math.cos(theta);
    }),
  );
  // The panel's two ends meet at the back (theta = ±π); a slim pillar that
  // encloses both end faces fuses them into one solid.
  const pillarW = Math.max(1.2, g.post * 0.8);
  const pillar = keep(
    keep(Manifold.cube([pillarW, g.H, g.t + 0.1], true)).translate([0, g.H / 2, -(Ri + g.t / 2)]),
  );
  let lantern = keep(bent.add(pillar));

  // Floor and tealight pedestal.
  const floor = p.floor;
  const disk = keep(keep(Manifold.cylinder(floor, g.D / 2 - 0.02, g.D / 2 - 0.02, 128)).rotate([-90, 0, 0]));
  lantern = keep(lantern.add(disk));
  const R = p.candleDiameter / 2;
  const pocket = 8;
  const bossH = floor + p.candleLift + pocket;
  const bossR = Math.min(R + 2.4, Ri - 1);
  if (bossR > R + 0.8) {
    const boss = keep(keep(Manifold.cylinder(bossH, bossR, bossR, 96)).rotate([-90, 0, 0]));
    const cut = keep(
      keep(keep(Manifold.cylinder(pocket + 1, R + 0.4, R + 0.4, 96)).rotate([-90, 0, 0])).translate([0, bossH - pocket, 0]),
    );
    lantern = keep(keep(lantern.add(boss)).subtract(cut));
  }
  const props = { type: 'candle', candle: { x: 0, z: 0, y: bossH - pocket, r: R } };
  return { manifold: lantern, garbage, props };
}

/**
 * Printed standing up, the top edge of every opening is a bridge. Returns the
 * widest flat-topped opening in mm (measured just under its top).
 */
export function widestOpeningTop(solid, layout) {
  const { labels, count } = components(solid, 0);
  const { w, h } = solid;
  const touches = new Uint8Array(count + 1);
  for (let x = 0; x < w; x++) touches[labels[x]] = touches[labels[(h - 1) * w + x]] = 1;
  for (let y = 0; y < h; y++) touches[labels[y * w]] = touches[labels[y * w + w - 1]] = 1;
  const top = new Int32Array(count + 1).fill(-1);
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    if (l && !touches[l] && top[l] < 0) top[l] = Math.floor(i / w);
  }
  const dy = Math.max(1, Math.round(layout.res * 0.5));
  let widest = 0;
  for (let l = 1; l <= count; l++) {
    if (touches[l] || top[l] < 0) continue;
    const y = Math.min(h - 1, top[l] + dy);
    let run = 0;
    for (let x = 0; x < w; x++) {
      if (labels[y * w + x] === l) {
        run++;
        if (run > widest) widest = run;
      } else run = 0;
    }
  }
  return widest / layout.res;
}
