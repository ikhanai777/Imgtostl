import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  optimizeDeps: { exclude: ['manifold-3d'] },
  build: { target: 'es2022' },
  test: { environment: 'node' },
});
