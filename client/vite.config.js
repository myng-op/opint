import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // REST API — browser fetches /api/... which is forwarded unchanged to the server.
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      // Realtime WS — path is stripped so /ws?interviewId=... reaches the server as /?interviewId=...
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
        rewrite: (p) => p.replace(/^\/ws/, ''),
      },
    },
  },
});
