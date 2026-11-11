import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // loaded from file:// inside Electron
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
});
