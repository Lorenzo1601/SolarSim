import { defineConfig } from 'vite';
import { spaceDataPlugin } from './server/spaceDataPlugin.ts';

export default defineConfig({
  // Proxy locale con cache per CelesTrak, JPL Horizons e NASA DSN Now (vedi server/spaceDataPlugin.ts)
  plugins: [spaceDataPlugin()],
  server: { open: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 1000 }, // three.js da solo pesa ~600 kB
  worker: { format: 'es' },
});
