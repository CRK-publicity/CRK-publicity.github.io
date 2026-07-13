import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/crkpublicity/',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        admin: resolve(import.meta.dirname, 'admin/index.html')
      }
    }
  }
});