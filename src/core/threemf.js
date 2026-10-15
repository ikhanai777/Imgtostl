// 3MF writer: one object made of coloured parts, which slicers (Bambu
// Studio, PrusaSlicer, Orca, Cura) load as a single multi-part object.
import { makeZip } from './zip.js';

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * @param parts [{ name, color: '#rrggbb', positions: Float32Array, indices: Uint32Array }]
 * @returns Uint8Array (.3mf file)
 */
export function make3MF(parts, title = 'Imgtostl') {
  const f = (v) => +v.toFixed(4);
  const materials = parts
    .map((p) => `<base name="${esc(p.name)}" displaycolor="${p.color.toUpperCase()}FF"/>`)
    .join('');
  const objects = parts
    .map((p, k) => {
      const v = [];
      for (let i = 0; i < p.positions.length; i += 3) {
        v.push(`<vertex x="${f(p.positions[i])}" y="${f(p.positions[i + 1])}" z="${f(p.positions[i + 2])}"/>`);
      }
      const t = [];
      for (let i = 0; i < p.indices.length; i += 3) {
        t.push(`<triangle v1="${p.indices[i]}" v2="${p.indices[i + 1]}" v3="${p.indices[i + 2]}"/>`);
      }
      return `<object id="${k + 2}" name="${esc(p.name)}" type="model" pid="1" pindex="${k}"><mesh><vertices>${v.join('')}</vertices><triangles>${t.join('')}</triangles></mesh></object>`;
    })
    .join('\n');
  const assembly = parts.length + 2;
  const components = parts.map((_, k) => `<component objectid="${k + 2}"/>`).join('');
  const model =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n` +
    `<metadata name="Title">${esc(title)}</metadata>\n<metadata name="Application">Imgtostl</metadata>\n` +
    `<resources>\n<basematerials id="1">${materials}</basematerials>\n${objects}\n` +
    `<object id="${assembly}" name="${esc(title)}" type="model"><components>${components}</components></object>\n` +
    `</resources>\n<build><item objectid="${assembly}"/></build>\n</model>\n`;
  return makeZip([
    {
      name: '[Content_Types].xml',
      data:
        '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>',
    },
    {
      name: '_rels/.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
    },
    { name: '3D/3dmodel.model', data: model },
  ]);
}
