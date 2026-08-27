/* client bundle 加载冒烟测试：模拟 DSH 模块加载器执行 client.js，
 * 捕获模块级与 apply() 级的运行时错误（语法检查发现不了的 undefined 引用/坏补丁）。
 * 用法：node tests/plugin_client_smoke.test.mjs [bundle路径，默认 repo client.js]
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = process.argv.find((a) => a.endsWith("client.js"))
  || path.join(__dirname, "..", "plugins", "trading-dashboard", "client.js");

test("client.js 可被加载器装载且 apply 可执行", () => {
  let captured = null;
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    __ModuleLoader__: {
      load(def) { captured = def; },
    },
  };
  // 执行 bundle（工厂只注册不执行）
  const code = fs.readFileSync(BUNDLE, "utf8");
  // 用 Function 构造以隔离作用域，注入 window
  const runner = new Function("window", `${code}`);
  runner(globalThis.window);
  assert.ok(captured, "bundle 必须调用 __ModuleLoader__.load 自注册");
  assert.equal(captured.id, "@bhn/trading-dashboard");

  // 模拟 shell 的模块表：只提供 react / react/jsx-runtime
  const reactStub = {
    createElement: (tag, props, ...kids) => ({ tag, props, kids }),
    Fragment: Symbol("Fragment"),
    useState: () => [null, () => {}],
    useEffect: () => {},
    useMemo: (f) => f(),
  };
  const requireMock = (id) => {
    if (id === "react") return reactStub;
    if (id === "react/jsx-runtime") return { jsx: reactStub.createElement, jsxs: reactStub.createElement, Fragment: reactStub.Fragment };
    throw new Error("bundle 引用了未预期的外部模块: " + id);
  };
  const exportsObj = captured.factory(requireMock);   // 工厂返回模块导出（内部 module.exports）
  assert.equal(typeof exportsObj.apply, "function", "导出 apply");
  assert.ok(Array.isArray(exportsObj.inject), "导出 inject");

  // 模拟 ctx.slots 执行 apply：注册回调应被注入
  const registered = [];
  const ctx = {
    slots: {
      inject(name, fn) { registered.push({ name, fn }); fn(); },
      register(def, Component) { registered.push({ name: def.name, id: def.id, Component }); },
    },
  };
  exportsObj.apply(ctx);
  const btn = registered.find((r) => r.id === "trading-dashboard");
  assert.ok(btn, "apply 必须注册 trading-dashboard 槽位");
  assert.equal(typeof btn.Component, "function", "按钮组件是函数");
});
