import { defineConfig } from 'vitest/config';

export default defineConfig({
  // vite 5 的 ssr 层：node:sqlite 不在内置清单，显式 external 保前缀
  ssr: { external: ['node:sqlite'] },
  test: {
    server: {
      deps: {
        external: [/^node:/, /^sqlite$/],
      },
    },
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
