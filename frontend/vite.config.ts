import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = path.dirname(fileURLToPath(import.meta.url));
// `npm run dev` proxies the API to the backend running standalone (`npm start`).
const backend = process.env.PLUGIN_BACKEND || 'http://127.0.0.1:7470';

export default defineConfig({
  root: here,
  base: './',
  plugins: [react()],
  build: { outDir: path.join(here, 'dist'), emptyOutDir: true },
  server: { proxy: { '/api': { target: backend, ws: true } } },
});
