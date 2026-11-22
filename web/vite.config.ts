import { svelte } from '@sveltejs/vite-plugin-svelte';
import { unwreck } from '@unwreck/core/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [svelte(), unwreck()],
  build: {
    outDir: '../dist/public',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
});
