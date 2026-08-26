/* 插件模块一致性防回归测试：
 * host.js 里 require 解构的 route 名字必须全部存在于 route.js 的 module.exports——
 * 防止"路由块加了、import 忘了"的静默失败再次发生（2026-08-19 ReferenceError 事故根因）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..", "plugins", "trading-dashboard", "src");

test("host.js 解构的 route 符号全部存在于 route.js 导出", () => {
  const hostSrc = fs.readFileSync(path.join(root, "host.js"), "utf8");
  const routeSrc = fs.readFileSync(path.join(root, "route.js"), "utf8");
  const m = hostSrc.match(/require\("\.\/route"\)/);
  assert.ok(m, "host.js 必须从 ./route 引入");
  const destructure = hostSrc.match(/require\("\.\/route"\)/) &&
    hostSrc.split("\n").find((l) => l.includes('require("./route")'));
  const names = [...destructure.matchAll(/(\w+)(?=,|\s*\})/g)].map((x) => x[1]);
  const exportsLine = routeSrc.split("\n").find((l) => l.includes("module.exports"));
  for (const n of names) {
    assert.ok(exportsLine.includes(n), `route.js 导出缺少 ${n}`);
  }
  // handler 里引用的函数名也必须在 require 解构里（双向校验）
  for (const fn of ["sectorDaily", "indexDaily", "stockDaily"]) {
    if (hostSrc.includes(`const out = ${fn}(`)) {
      assert.ok(destructure.includes(fn), `host.js 使用了 ${fn} 但未在 require 解构中引入`);
    }
  }
});
