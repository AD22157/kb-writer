import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// dev 时前端 5173，API 代理到本机后端 4177（生产是 vite build 后由后端同源托管）。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4177', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
