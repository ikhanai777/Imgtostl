// Functional bases the art slides into: a plain slot stand, or something you
// use every day (pen cup, desk organizer, trinket tray, tealight holder,
// planter, bookend).
//
// Model coordinates match the piece: X across, Y up, Z towards the viewer.
// The art stands in a slot centred on z = slab / 2 with its bottom at y = 0.
// Tall parts always go BEHIND the art (z < 0) and only low parts in front,
// so the base never hides the silhouette.
import { buildStand } from './mesh.js';

export const STAND_TYPES = [
  ['none', 'None'],
  ['block', 'Slot stand'],
  ['pencil', 'Pen & pencil cup'],
  ['organizer', 'Desk organizer'],
  ['tray', 'Trinket / key tray'],
  ['candle', 'Tealight holder'],
  ['planter', 'Mini planter'],
  ['bookend', 'Bookend'],
];

/**
 * Sensible starting sizes for a base type, scaled to the piece.
 * @param type    stand type
 * @param artW    piece width (mm)
 * @param artH    piece height including the foot (mm)
 */
export function standDefaults(type, artW, artH) {
  const clamp = (v, a, b) => Math.round(Math.max(a, Math.min(b, v)));
  switch (type) {
    case 'pencil':
      // Pens poke out above the art; the cup itself stays below its top.
      return { containerHeight: clamp(artH * 0.7, 60, 110), containerDepth: 55, containerWidth: clamp(artW * 0.7, 60, 120), compartments: 1 };
    case 'organizer':
      return { containerHeight: clamp(artH * 0.6, 50, 100), containerDepth: 60, containerWidth: clamp(artW * 1.1, 80, 220), compartments: 3, trayDepth: 35 };
    case 'tray':
      return { trayDepth: clamp(artW * 0.5, 35, 90), containerWidth: clamp(artW * 1.05, 70, 220) };
    case 'candle':
      // The flame sits about a third of the way up so light reaches the art.
      return { candleDiameter: 39.5, candleGap: 25, candleLift: clamp(artH * 0.18, 0, 40) };
    case 'planter':
      return { containerHeight: clamp(artH * 0.5, 45, 80), containerDepth: 65, containerWidth: clamp(artW * 0.75, 60, 120), drainHole: false };
    case 'bookend':
      return { bookendDepth: 110, containerHeight: clamp(artH * 0.85, 60, 160), containerWidth: clamp(artW, 90, 160) };
    default:
      return { standDepth: 30, standHeight: 12 };
  }
}

/**
 * @param wasm manifold module
 * @param p {
 *   type, slab, clearance, baseWidth, slotDepth, wall,
 *   containerWidth, containerDepth, containerHeight, compartments,
 *   trayDepth, candleDiameter, candleGap, candleLift, drainHole,
 *   bookendDepth, depth, height
 * }
 * @returns { manifold, garbage, props } props describe where display-only
 *          items (pencils, tealight, plant, books) go in the preview.
 */
export function buildFunctionalStand(wasm, p) {
  if (p.type === 'block') {
    const b = buildStand(wasm, { ...p, wall: 4, chamfer: 2 });
    return { ...b, props: { type: 'block' } };
  }
  const { CrossSection, Manifold } = wasm;
  const garbage = [];
  const keep = (o) => (garbage.push(o), o);

  const wall = Math.max(1.6, p.wall);
  const floor = 2.4;
  const slotW = p.slab + p.clearance;
  const slotL = p.baseWidth + 2 * p.clearance;
  const zSlot0 = p.slab / 2 - slotW / 2;
  const zSlot1 = p.slab / 2 + slotW / 2;
  const yG = -floor; // ground under the slot floor
  const minL = slotL + 2 * wall;

  // Rounded box: footprint x0..x1 / z0..z1, from height y0 to y0 + h.
  const box = (x0, x1, z0, z1, y0, h, r = 0) => {
    const w = x1 - x0;
    const d = z1 - z0;
    const rr = Math.max(0, Math.min(r, w / 2 - 0.05, d / 2 - 0.05));
    let cs = keep(CrossSection.square([w, d], true));
    if (rr > 0.2) cs = keep(keep(cs.offset(-rr, 'Round')).offset(rr, 'Round'));
    cs = keep(cs.translate([(x0 + x1) / 2, -(z0 + z1) / 2]));
    return keep(keep(keep(cs.extrude(h)).rotate([-90, 0, 0])).translate([0, y0, 0]));
  };
  const cylinder = (x, z, y0, h, r) =>
    keep(keep(keep(Manifold.cylinder(h, r, r, 64)).rotate([-90, 0, 0])).translate([x, y0, z]));

  const parts = [];
  const cuts = [];
  const props = { type: p.type, cavities: [] };

  // Plinth holding the slot (shared by every type).
  const plinthL = (w) => Math.max(minL, w);
  const plinthFront = zSlot1 + wall;
  const plinthBack = zSlot0 - wall;
  const addPlinth = (w) => parts.push(box(-w / 2, w / 2, plinthBack, plinthFront, yG, p.slotDepth + floor, 1.5));

  // An open-top container. `dividers` splits it into compartments along X.
  const container = (x0, x1, z0, z1, h, n = 1, r = 6) => {
    parts.push(box(x0, x1, z0, z1, yG, h, r));
    const inner = (x1 - x0 - 2 * wall - (n - 1) * wall) / n;
    for (let k = 0; k < n; k++) {
      const cx0 = x0 + wall + k * (inner + wall);
      const cav = { x0: cx0, x1: cx0 + inner, z0: z0 + wall, z1: z1 - wall, yFloor: yG + floor, yTop: yG + h };
      cuts.push(box(cav.x0, cav.x1, cav.z0, cav.z1, cav.yFloor, h + 1, Math.max(0, r - wall)));
      props.cavities.push(cav);
    }
  };

  switch (p.type) {
    case 'pencil':
    case 'planter': {
      const W = plinthL(p.containerWidth);
      addPlinth(W);
      container(-W / 2, W / 2, plinthBack - p.containerDepth + wall, plinthBack + wall, p.containerHeight, 1, 8);
      if (p.type === 'planter' && p.drainHole) {
        const c = props.cavities[0];
        cuts.push(cylinder(0, (c.z0 + c.z1) / 2, yG - 1, floor + 2, 3));
      }
      break;
    }
    case 'organizer': {
      const W = plinthL(p.containerWidth);
      addPlinth(W);
      container(-W / 2, W / 2, plinthBack - p.containerDepth + wall, plinthBack + wall, p.containerHeight, Math.max(1, Math.round(p.compartments)), 5);
      // Low tray in front for clips and erasers: no taller than the slot.
      container(-W / 2, W / 2, plinthFront - wall, plinthFront - wall + p.trayDepth, p.slotDepth + floor, 1, 5);
      break;
    }
    case 'tray': {
      const W = plinthL(p.containerWidth);
      addPlinth(W);
      container(-W / 2, W / 2, plinthFront - wall, plinthFront - wall + p.trayDepth, p.slotDepth + floor, 1, 8);
      break;
    }
    case 'candle': {
      // A pedestal behind the art with a pocket for a (LED) tealight.
      const R = p.candleDiameter / 2;
      const bossR = R + wall;
      const cz = plinthBack - p.candleGap - bossR;
      const W = plinthL(2 * bossR + 10);
      addPlinth(W);
      parts.push(box(-W / 2, W / 2, cz - bossR - 4, plinthFront, yG, floor, 6)); // base plate
      const pocket = 8;
      const bossH = floor + p.candleLift + pocket;
      parts.push(cylinder(0, cz, yG, bossH, bossR));
      cuts.push(cylinder(0, cz, yG + bossH - pocket, pocket + 1, R + 0.4));
      props.candle = { x: 0, z: cz, y: yG + bossH - pocket, r: R };
      break;
    }
    case 'bookend': {
      // Books stand on the plate behind a support wall; the art is in front.
      const W = plinthL(p.containerWidth);
      addPlinth(W);
      const plateBack = plinthBack - 4 - p.bookendDepth;
      parts.push(box(-W / 2, W / 2, plateBack, plinthFront, yG, 4, 4));
      parts.push(box(-W / 2, W / 2, plinthBack - 4, plinthBack + 0.5, yG, p.containerHeight, 1.5));
      props.books = { x0: -W / 2, x1: W / 2, z0: plateBack, z1: plinthBack - 4, y: yG + 4, h: p.containerHeight };
      break;
    }
    default:
      addPlinth(minL);
  }

  let stand = parts.length === 1 ? parts[0] : keep(Manifold.union(parts));
  // The art slot, then every pocket and cavity.
  cuts.push(keep(keep(Manifold.cube([slotL, p.slotDepth + 1, slotW])).translate([-slotL / 2, 0, zSlot0])));
  for (const c of cuts) stand = keep(stand.subtract(c));
  props.ground = yG;
  return { manifold: stand, garbage, props };
}
