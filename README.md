# Imgtostl: image → SVG → STL silhouette frames

A browser app that turns any image into 2D silhouette art inside a frame, ready to 3D print and stand upright on a shelf. It is built so that **nothing falls out**: every part of the art ends up connected to the frame.

Everything runs locally in the browser. Your images are never uploaded.

## Features

**Image → silhouette**
- Open a PNG, JPG, WebP or SVG by file picker, drag & drop or paste (Ctrl/Cmd+V).
- Three ways to find the subject:
  - brightness, with an automatic Otsu threshold
  - transparency, for PNG cut-outs
  - a background colour key, with a "pick from image" eyedropper
- The app guesses the mode and the invert setting when an image is loaded. A transparent PNG switches to alpha mode, and light-on-dark art is inverted automatically.
- Clean-up controls: pre-blur, speck removal, pinhole fill, line weight (thicken/thin) and spike shaving. All sizes are in real millimetres.

**Frames**
- Circle, oval, rectangle (with rounded corners), arch window, hexagon, octagon, or no frame.
- The frame thickness is uniform for every shape (it is computed with an exact distance transform).
- "Break out of the frame" lets the art overlap and extend past the border.
- Placement: drag the 2D preview to move the art, scroll or pinch to scale. Rotate and mirror are in the sidebar.

**Printability (no break lines)**
- Floating islands (a moon, stars, birds, a pupil inside an eye) are detected using 4-connectivity, because parts that only touch at a corner don't count as connected. Each island is **auto-bridged** to the frame along the shortest path. You can also remove them, or keep them if you really want to.
- A thin-feature check highlights every area thinner than your minimum printable width.
- Live badges show whether the result is one solid piece, how many bridges were added, the size, the volume, an approximate PLA weight, and whether the mesh is watertight.

**Hand editing**
- Use the Move / Add / Erase tools above the 2D preview. Add paints material on and Erase removes art, with an adjustable brush size.
- Painting your own bridge to the frame replaces the automatic one.
- Undo with Ctrl/Cmd+Z. Keyboard shortcuts: V (move), B (add), E (erase).

**Text on the foot**
- Add a name, date or caption, engraved, embossed or cut through as a stencil. There are five font styles.
- The foot grows to fit the text, and when a slot stand is used the text sits above the slot so it stays visible.

**Layered depth (shadow box)**
- Split the art into 2–4 tone bands. Darker parts stand taller, which gives a layered, shadow-box look.
- Tones are found by clustering, so flat-coloured art splits exactly at its colours.
- The SVG export keeps each depth layer as its own group, which is useful for layered laser cutting.

**Standing it up**
- A flat **foot** under any frame shape gives it a flat bottom.
- An optional **deep foot** (centred or front-only) makes the piece stand on its own.
- Or generate a **separate slot stand**: a desk block with a friction-fit slot sized to the slab thickness plus a clearance you set. The piece and the stand both print flat with no supports.

**3D / export**
- Separate thicknesses for the art and the frame, so you can raise the frame for a framed look.
- The meshes are built with [manifold-3d](https://github.com/elalish/manifold). Its boolean operations guarantee a **watertight, manifold** STL: no overlapping shells and no repair step in the slicer.
- STL orientation: lying flat (recommended) or standing on its foot.
- Exports:
  - **binary STL** of the piece
  - **STL** of the stand
  - **SVG** in millimetre units, also handy for laser cutters and Cricut machines

## Getting started

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # core pipeline tests (Node + manifold wasm)
npm run build    # static site in dist/ (deployable anywhere)
npm run build:artifact  # one self-contained HTML file in dist-artifact/
```

## How it works

```
image ─► placed on a mm-scaled canvas ─► ink field ─► blur ─► threshold
      ─► clean-up (EDT morphology, component filtering)
      ─► compose: frame ring ∪ foot ∪ (art ∩ frame opening)
      ─► island detection + Prim-style shortest bridges
      ─► marching squares ─► Taubin smoothing ─► RDP simplification   (= SVG)
      ─► manifold CrossSection ─► extrude ─► union (raised frame, deep foot)
      ─► binary STL
```

| File | Responsibility |
| --- | --- |
| `src/core/mask.js` | Binary masks, exact Euclidean distance transform, morphology, connected components |
| `src/core/bridge.js` | Island detection and auto-bridging |
| `src/core/compose.js` | Frame shapes, layout and composition |
| `src/core/trace.js` | Marching squares, smoothing, simplification |
| `src/core/mesh.js` | Extrusion, foot and stand, STL and SVG writers |
| `src/core/pipeline.js` | Default settings and the 2D/3D build steps |
| `src/image.js` | Image loading, auto-detection, placement, sample art |
| `src/ui/*` | Control schema, presets, three.js preview |

## Printing tips

- Print the piece lying flat at 0.2 mm layers. Supports are only needed if you use a centred deep foot.
- Keep the minimum feature size and the bridge width at least 2–3× your nozzle diameter. The defaults (1.2 mm and 2 mm) suit a 0.4 mm nozzle.
- For the slot stand, 0.2–0.3 mm of clearance gives a snug fit on most printers.
