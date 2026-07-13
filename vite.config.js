import { defineConfig } from 'vite';

export default defineConfig({
  base: '/crk-publicity-portfolio/',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true
  }
});