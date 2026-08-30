import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 3100,
    host: '0.0.0.0',
    // Proxying keeps the browser on one origin, so no CORS in dev and the
    // deployed build can sit behind the same reverse proxy as the API.
    proxy: {
      '/api': {
        target: process.env.VITE_API_URL || 'http://localhost:8003',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
});
