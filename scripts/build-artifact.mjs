// Builds a single self-contained HTML page (JS, CSS and the manifold wasm all
// inlined) for publishing as a claude.ai Artifact: dist-artifact/imgtostl.html
import { build } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

const outDir = 'dist-artifact';
await build({
  logLevel: 'warn',
  build: {
    outDir,
    emptyOutDir: true,
    assetsInlineLimit: 100 * 1024 * 1024,
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});

let html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
const read = (href) => fs.readFileSync(path.join(outDir, href.replace(/^\.?\//, '')), 'utf8');

let css = '';
html = html.replace(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (_, href) => {
  css += read(href);
  return '';
});
let js = '';
html = html.replace(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g, (_, src) => {
  js += read(src);
  return '';
});
js = js.replace(/<\/script/gi, '<\\/script');

const head = html.match(/<head>([\s\S]*?)<\/head>/)[1];
const title = head.match(/<title>[\s\S]*?<\/title>/)[0];
const body = html.match(/<body>([\s\S]*?)<\/body>/)[1];
const page = `${title}\n<style>\nhtml,body{height:100%}\n${css}</style>\n${body.trim()}\n<script type="module">\n${js}\n</script>\n`;
fs.writeFileSync(path.join(outDir, 'imgtostl.html'), page);
console.log(`wrote ${outDir}/imgtostl.html (${(page.length / 1024).toFixed(0)} KB)`);
