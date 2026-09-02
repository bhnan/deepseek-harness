import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // 访问链路: Caddy/GUI(3080) → apps-proxy 挂 /calendar 前缀 → 本服务（代理剥前缀）。
  // 资源必须以 /calendar/assets/... 绝对路径引用，否则经代理访问时打到 GUI 本体 404 白屏。
  // 服务端在 server/index.mjs 已有 /calendar 前缀静态别名，直连 8787 亦可访问。
  base: '/calendar/',
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
  build: { outDir: 'dist' },
});
