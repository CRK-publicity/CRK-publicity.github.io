import { defineConfig } from 'vite';

export default defineConfig({
  base: '/crkpublicity/',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true
  }
});