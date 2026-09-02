import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // 访问链路: Caddy/GUI(3080) → apps-proxy 挂 /portfolio 前缀 → 本服务（代理剥前缀）。
  // GUI 面板入口是 ${origin}/portfolio/，资源必须以 /portfolio/assets/... 绝对路径引用，
  // 否则经代理访问时打到 GUI 本体 404 白屏（约定见 dsh-plugins/apps-proxy/lib/index.js 头注释）。
  // 服务端在 server/index.mjs 为 /portfolio 前缀提供同名别名，直连 8797 亦可访问。
  base: '/portfolio/',
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/api/portfolio': { target: 'http://127.0.0.1:8797', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          echarts: ['echarts'],
          xlsx: ['xlsx'],
        },
      },
    },
  },
});
