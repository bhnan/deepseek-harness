// 桥接插件打包脚本：esbuild 打包 + __ModuleLoader__.load 包装（与 DSH 内部 client 插件同构）
// 产物：dist-bridge/@bhn/teacher-calendar-bridge/{package.json, lib/index.js, lib/client.js}
// 用法：node scripts/build-bridge.mjs [--install]   （--install 复制到 DSH 运行时 node_modules）
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist-bridge', '@bhn', 'teacher-calendar-bridge');

fs.mkdirSync(path.join(OUT, 'lib'), { recursive: true });

// 1. esbuild 打包为 commonjs（React 等走 require，由 __ModuleLoader__ 提供）
await build({
  entryPoints: [path.join(ROOT, 'plugins', 'bridge', 'src', 'index.jsx')],
  outfile: path.join(OUT, 'lib', 'client.bundle.js'),
  bundle: true,
  format: 'cjs',
  platform: 'neutral',
  jsx: 'automatic',
  external: ['react', '@deepseek-ai/cordis'],
  logLevel: 'warning',
});

// 2. __ModuleLoader__.load 包装（对齐内部 client 插件格式）
const bundle = fs.readFileSync(path.join(OUT, 'lib', 'client.bundle.js'), 'utf-8');
const wrapped = `window.__ModuleLoader__.load({
  id: "@bhn/teacher-calendar-bridge",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    ${bundle}
    return module.exports;
  }
});
`;
fs.writeFileSync(path.join(OUT, 'lib', 'client.js'), wrapped);
fs.unlinkSync(path.join(OUT, 'lib', 'client.bundle.js'));

// 3. 入口（host 半边空实现，client 标记）
const pkg = {
  name: '@bhn/teacher-calendar-bridge',
  version: '0.1.0',
  private: true,
  main: 'lib/index.js',
  type: 'module',
  exports: {
    '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
    './client': { default: './lib/client.js' },
    './package.json': './package.json',
  },
  dsh: {
    client: {
      inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-layout'],
      platform: 'web',
    },
  },
};
fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify(pkg, null, 2));
fs.writeFileSync(
  path.join(OUT, 'lib', 'index.js'),
  '// Host 半边：浏览器专用插件，无 host 行为（与内部 client 插件同构）。\n/** Provides no host-side behavior. */\nfunction apply() {}\nexport { apply };\n'
);

// 4. 可选安装（插件解析位置 = profile node_modules，实测确认）
if (process.argv.includes('--install')) {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const target = `${home}/profiles/web/node_modules/@bhn/teacher-calendar-bridge`;
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(path.join(OUT), target, { recursive: true });
  console.log('已安装到 profile node_modules:', target);
}

console.log('✅ 桥接插件打包完成:', OUT);
console.log('   条目配置（cordis.patch.yml insert）:');
console.log(`
- insert:
    - id: teacher-calendar-bridge
      name: '@bhn/teacher-calendar-bridge'
`);
