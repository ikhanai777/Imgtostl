// Common printer build volumes (mm) and a fit check.
export const PRINTERS = [
  ['bambu-a1', 'Bambu Lab A1 / P1S / X1C', [256, 256, 256]],
  ['bambu-a1mini', 'Bambu Lab A1 mini', [180, 180, 180]],
  ['bambu-h2d', 'Bambu Lab H2D', [325, 320, 325]],
  ['prusa-mk4', 'Prusa MK4 / MK4S', [250, 210, 220]],
  ['prusa-mini', 'Prusa MINI+', [180, 180, 180]],
  ['prusa-core', 'Prusa Core One', [250, 220, 270]],
  ['ender3', 'Creality Ender-3 (V2/V3)', [220, 220, 250]],
  ['k1', 'Creality K1 / K1C', [220, 220, 250]],
  ['k1max', 'Creality K1 Max', [300, 300, 300]],
  ['neptune4', 'Elegoo Neptune 4 Pro', [225, 225, 265]],
  ['custom-300', 'Large format (300 × 300)', [300, 300, 300]],
];

export function printerById(id) {
  return PRINTERS.find((p) => p[0] === id) || PRINTERS[0];
}

/**
 * Does a part of footprint [x, y] and height z fit the bed? Allows a 90°
 * turn on the bed. Returns { fits, scale } where scale is the largest uniform
 * scale factor (≤ 1) that would make it fit.
 */
export function fitsBed(size, bed, margin = 4) {
  const [x, y, z] = size;
  const bx = bed[0] - margin;
  const by = bed[1] - margin;
  const scaleFor = (a, b) => Math.min(bx / a, by / b, bed[2] / z);
  const scale = Math.max(scaleFor(x, y), scaleFor(y, x));
  return { fits: scale >= 1, scale: Math.min(1, scale) };
}
