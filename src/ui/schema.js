import { PRINTERS } from '../core/printers.js';

// Declarative control definitions. `show(s)` hides irrelevant controls.
const hasHeight = (s) => ['oval', 'rect', 'arch', 'none'].includes(s.frameShape);
const hasBase = (s) => s.baseStyle !== 'none';
const hasText = (s) => hasBase(s) && !!(s.text && s.text.trim());

export const SECTIONS = [
  {
    id: 'image',
    title: 'Image → silhouette',
    open: true,
    controls: [
      {
        key: 'mode',
        label: 'Detect subject by',
        type: 'select',
        options: [
          ['luminance', 'Brightness (dark = solid)'],
          ['alpha', 'Transparency (PNG cut-out)'],
          ['color', 'Background colour key'],
        ],
      },
      { key: 'keyColor', label: 'Background colour', type: 'color', show: (s) => s.mode === 'color', pick: true },
      { key: 'invert', label: 'Invert (swap solid / empty)', type: 'checkbox' },
      { key: 'autoThreshold', label: 'Auto threshold (Otsu)', type: 'checkbox', show: (s) => s.mode !== 'alpha' },
      {
        key: 'threshold',
        label: 'Threshold',
        type: 'range',
        min: 1,
        max: 254,
        step: 1,
        show: (s) => !s.autoThreshold || s.mode === 'alpha',
      },
      { key: 'blur', label: 'Pre-blur', unit: 'mm', type: 'range', min: 0, max: 3, step: 0.05 },
      { key: 'despeckle', label: 'Remove specks under', unit: 'mm²', type: 'range', min: 0, max: 50, step: 0.5 },
      { key: 'fillHoles', label: 'Fill pinholes under', unit: 'mm²', type: 'range', min: 0, max: 50, step: 0.5 },
      { key: 'lineWeight', label: 'Line weight', unit: 'mm', type: 'range', min: -1.5, max: 3, step: 0.05, hint: 'Thicken (+) or thin (−) the art' },
      { key: 'smoothArt', label: 'Shave spikes', unit: 'mm', type: 'range', min: 0, max: 2, step: 0.05 },
    ],
  },
  {
    id: 'place',
    title: 'Placement',
    open: true,
    hint: 'Tip: drag the 2D preview to move, scroll / pinch to scale.',
    controls: [
      { key: 'artScale', label: 'Scale', type: 'range', min: 0.1, max: 3, step: 0.01 },
      { key: 'offsetX', label: 'Offset X', unit: 'mm', type: 'range', min: -150, max: 150, step: 0.5 },
      { key: 'offsetY', label: 'Offset Y', unit: 'mm', type: 'range', min: -150, max: 150, step: 0.5 },
      { key: 'rotation', label: 'Rotate', unit: '°', type: 'range', min: -180, max: 180, step: 1 },
      { key: 'flipX', label: 'Mirror', type: 'checkbox' },
      { key: 'breakout', label: 'Let art break out of the frame', type: 'checkbox' },
    ],
  },
  {
    id: 'frame',
    title: 'Frame',
    open: true,
    controls: [
      {
        key: 'frameShape',
        label: 'Shape',
        type: 'select',
        options: [
          ['circle', 'Circle'],
          ['oval', 'Oval'],
          ['rect', 'Rectangle'],
          ['arch', 'Arch window'],
          ['hexagon', 'Hexagon'],
          ['octagon', 'Octagon'],
          ['none', 'No frame (art only)'],
        ],
      },
      { key: 'width', label: 'Width', unit: 'mm', type: 'range', min: 20, max: 300, step: 1 },
      { key: 'height', label: 'Height', unit: 'mm', type: 'range', min: 20, max: 300, step: 1, show: hasHeight },
      { key: 'frameWidth', label: 'Frame thickness', unit: 'mm', type: 'range', min: 1, max: 20, step: 0.5, show: (s) => s.frameShape !== 'none' },
      {
        key: 'hanger',
        label: 'Hanging',
        type: 'select',
        options: [
          ['none', 'None'],
          ['loop', 'Loop on top (ornament / keychain)'],
          ['hole', 'Hole through the frame top'],
        ],
        show: (s) => s.frameShape !== 'none',
      },
      { key: 'hangerHole', label: 'Hole diameter', unit: 'mm', type: 'range', min: 2, max: 12, step: 0.5, show: (s) => s.frameShape !== 'none' && s.hanger !== 'none' },
      { key: 'hangerWall', label: 'Loop wall', unit: 'mm', type: 'range', min: 1.2, max: 6, step: 0.1, show: (s) => s.frameShape !== 'none' && s.hanger !== 'none' },
      { key: 'cornerRadius', label: 'Corner radius', unit: 'mm', type: 'range', min: 0, max: 60, step: 0.5, show: (s) => s.frameShape === 'rect' || s.frameShape === 'none' },
    ],
  },
  {
    id: 'stand',
    title: 'Standing base',
    open: true,
    controls: [
      {
        key: 'baseStyle',
        label: 'Base',
        type: 'select',
        options: [
          ['foot', 'Flat foot (stands upright)'],
          ['none', 'None'],
        ],
      },
      { key: 'baseWidth', label: 'Foot width', unit: 'mm', type: 'range', min: 10, max: 300, step: 1, show: hasBase },
      { key: 'baseHeight', label: 'Foot height', unit: 'mm', type: 'range', min: 2, max: 40, step: 0.5, show: hasBase },
      {
        key: 'footDepth',
        label: 'Foot depth',
        unit: 'mm',
        type: 'range',
        min: 0,
        max: 60,
        step: 1,
        show: hasBase,
        hint: '0 = same as the slab. Deeper = self-standing, no stand needed.',
      },
      {
        key: 'footPosition',
        label: 'Foot extends',
        type: 'select',
        options: [
          ['center', 'Both sides (most stable)'],
          ['front', 'Front only (flat back, prints flat)'],
        ],
        show: (s) => hasBase(s) && s.footDepth > 0,
      },
      {
        key: 'pocketDiameter',
        label: 'Pocket under foot',
        unit: 'mm',
        type: 'range',
        min: 0,
        max: 30,
        step: 0.5,
        show: (s) => hasBase(s) && s.footDepth > Math.max(s.artThickness, s.frameThickness),
        hint: 'For a magnet or coins as extra weight. 0 = off.',
      },
      { key: 'pocketDepth', label: 'Pocket depth', unit: 'mm', type: 'range', min: 0.5, max: 15, step: 0.5, show: (s) => hasBase(s) && s.footDepth > Math.max(s.artThickness, s.frameThickness) && s.pocketDiameter > 0 },
      { key: 'stand', label: 'Generate separate slot stand', type: 'checkbox', show: (s) => hasBase(s) && !(s.footDepth > Math.max(s.artThickness, s.frameThickness)) },
      { key: 'standDepth', label: 'Stand depth', unit: 'mm', type: 'range', min: 10, max: 80, step: 1, show: (s) => hasBase(s) && s.stand },
      { key: 'standHeight', label: 'Stand height', unit: 'mm', type: 'range', min: 5, max: 40, step: 0.5, show: (s) => hasBase(s) && s.stand },
      { key: 'slotDepth', label: 'Slot depth', unit: 'mm', type: 'range', min: 2, max: 30, step: 0.5, show: (s) => hasBase(s) && s.stand },
      { key: 'clearance', label: 'Slot clearance', unit: 'mm', type: 'range', min: 0, max: 1, step: 0.05, show: (s) => hasBase(s) && s.stand },
    ],
  },
  {
    id: 'text',
    title: 'Text on the foot',
    open: true,
    hint: 'A name, date or caption. The foot grows to fit it.',
    show: hasBase,
    controls: [
      { key: 'text', label: 'Text', type: 'text', placeholder: 'e.g. Emma · 2026', maxLength: 40 },
      {
        key: 'textMode',
        label: 'Style',
        type: 'select',
        options: [
          ['engrave', 'Engraved (cut into the front)'],
          ['emboss', 'Embossed (raised)'],
          ['cutout', 'Stencil (cut through)'],
        ],
        show: hasText,
      },
      {
        key: 'textFont',
        label: 'Font',
        type: 'select',
        options: [
          ['sans', 'Bold sans'],
          ['serif', 'Serif'],
          ['rounded', 'Rounded'],
          ['script', 'Script'],
          ['mono', 'Typewriter'],
        ],
        show: hasText,
      },
      { key: 'textBold', label: 'Bold', type: 'checkbox', show: hasText },
      { key: 'textSize', label: 'Letter height', unit: 'mm', type: 'range', min: 3, max: 30, step: 0.5, show: hasText },
      { key: 'textDepth', label: 'Depth', unit: 'mm', type: 'range', min: 0.2, max: 3, step: 0.1, show: (s) => hasText(s) && s.textMode !== 'cutout' },
    ],
  },
  {
    id: 'print',
    title: 'Printability',
    open: true,
    controls: [
      {
        key: 'islandMode',
        label: 'Floating parts',
        type: 'select',
        options: [
          ['bridge', 'Auto-bridge to frame'],
          ['remove', 'Remove'],
          ['keep', 'Keep (will fall out!)'],
        ],
      },
      { key: 'bridgeWidth', label: 'Bridge width', unit: 'mm', type: 'range', min: 0.8, max: 8, step: 0.1, show: (s) => s.islandMode === 'bridge' },
      { key: 'minIsland', label: 'Drop islands under', unit: 'mm²', type: 'range', min: 0, max: 40, step: 0.5 },
      { key: 'fixThin', label: 'Thicken only the too-thin parts', type: 'checkbox', show: (s) => s.minFeature > 0 },
      { key: 'minFeature', label: 'Warn below feature size', unit: 'mm', type: 'range', min: 0, max: 4, step: 0.1, hint: 'Usually 2–3× your nozzle width' },
    ],
  },
  {
    id: 'model',
    title: '3D model & export',
    open: true,
    controls: [
      { key: 'artThickness', label: 'Art thickness', unit: 'mm', type: 'range', min: 0.6, max: 20, step: 0.1 },
      {
        key: 'layers',
        label: 'Depth layers',
        type: 'range',
        min: 1,
        max: 4,
        step: 1,
        hint: 'Split the art by tone: darker parts stand taller (shadow-box look).',
      },
      { key: 'layerStep', label: 'Height per layer', unit: 'mm', type: 'range', min: 0.4, max: 5, step: 0.1, show: (s) => s.layers > 1 },
      { key: 'frameThickness', label: 'Frame + foot thickness', unit: 'mm', type: 'range', min: 0.6, max: 30, step: 0.1, hint: 'Thicker than the art = raised frame' },
      { key: 'bevel', label: 'Bevelled front edge', unit: 'mm', type: 'range', min: 0, max: 2, step: 0.1, hint: 'A small chamfer on the front edges. 0 = sharp.' },
      {
        key: 'printer',
        label: 'Your printer (bed size check)',
        type: 'select',
        options: PRINTERS.map(([id, name, [x, y]]) => [id, `${name} · ${x}×${y}`]),
      },
      {
        key: 'orientation',
        label: 'STL orientation',
        type: 'select',
        options: [
          ['flat', 'Lying flat (recommended)'],
          ['upright', 'Standing on its foot'],
        ],
      },
      { key: 'smoothing', label: 'Edge smoothing', type: 'range', min: 0, max: 10, step: 1 },
      { key: 'tolerance', label: 'Simplify tolerance', unit: 'mm', type: 'range', min: 0, max: 0.5, step: 0.01 },
      { key: 'resolution', label: 'Detail', unit: 'px/mm', type: 'range', min: 2, max: 14, step: 1, hint: 'Higher = finer detail, slower' },
    ],
  },
];

export const PRESETS = {
  ornament: {
    label: 'Ornament disc',
    values: { frameShape: 'circle', width: 80, frameWidth: 3.5, baseStyle: 'foot', baseWidth: 50, baseHeight: 5, footDepth: 0, artThickness: 2.4, frameThickness: 3.2, stand: true },
  },
  plaque: {
    label: 'Desk plaque',
    values: { frameShape: 'rect', width: 120, height: 90, cornerRadius: 8, frameWidth: 5, baseStyle: 'foot', baseWidth: 120, baseHeight: 6, footDepth: 30, footPosition: 'center', artThickness: 3, frameThickness: 4, stand: false },
  },
  window: {
    label: 'Arch window',
    values: { frameShape: 'arch', width: 90, height: 130, frameWidth: 5, baseStyle: 'foot', baseWidth: 100, baseHeight: 8, footDepth: 35, footPosition: 'center', artThickness: 3, frameThickness: 5, stand: false },
  },
  shadowbox: {
    label: 'Shadow box',
    values: { frameShape: 'rect', width: 130, height: 100, cornerRadius: 4, frameWidth: 5, baseStyle: 'foot', baseWidth: 130, baseHeight: 6, footDepth: 0, artThickness: 1.6, frameThickness: 6, layers: 3, layerStep: 1.4, stand: true },
  },
  cutout: {
    label: 'Laser / Cricut SVG',
    values: { frameShape: 'none', width: 120, height: 120, cornerRadius: 0, baseStyle: 'none', islandMode: 'bridge', stand: false },
  },
};
