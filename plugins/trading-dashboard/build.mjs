/** 构建 client.js：esbuild iife → __ModuleLoader__.load 自注册包装（与 DSH 内部插件 client 同构）。 */
import { build } from "esbuild";

await build({
  entryPoints: ["src/client/index.jsx"],
  bundle: true,
  format: "iife",
  globalName: "__TD_BUNDLE",
  platform: "browser",
  jsx: "automatic",
  target: "es2020",
  external: ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client"],
  outfile: "client.js",
  banner: {
    js: `window.__ModuleLoader__.load({\n  id: "@bhn/trading-dashboard",\n  factory: (require) => {\n    var module = { exports: {} };\n    var exports = module.exports;`,
  },
  footer: {
    js: `    module.exports.apply = __TD_BUNDLE.apply;\n    module.exports.inject = __TD_BUNDLE.inject;\n    return module.exports;\n  },\n});`,
  },
});
console.log("client.js built");
