/* host 路由纯逻辑单测（测试点 P2）：越界防护 / 仅 JSON / 404 / latest / lab 列表 / symbol 校验。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { resolveRequest, resolveLab, stockDaily, aggregateDaily, latestDate } = require("../plugins/trading-dashboard/src/route.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "td-route-"));
const dataRoot = tmp;
fs.mkdirSync(path.join(dataRoot, "market", "2026-08-17"), { recursive: true });
fs.writeFileSync(path.join(dataRoot, "market", "2026-08-17", "index_spot.json"), '{"ok":true}');
fs.mkdirSync(path.join(dataRoot, "calendar"), { recursive: true });
fs.writeFileSync(path.join(dataRoot, "calendar", "trade_dates.json"),
  JSON.stringify(["2026-08-14", "2026-08-17", "2026-08-18"]));

const labRoot = path.join(tmp, "lab");
fs.mkdirSync(path.join(labRoot, "ideas"), { recursive: true });
fs.writeFileSync(path.join(labRoot, "ideas", "idea_001.json"), JSON.stringify({ id: "idea_001", status: "draft" }));
fs.mkdirSync(path.join(labRoot, "signals", "signal_001"), { recursive: true });
fs.writeFileSync(path.join(labRoot, "signals", "signal_001", "v001.json"), JSON.stringify({ id: "signal_001", version: 1 }));
fs.mkdirSync(path.join(labRoot, "experiments"), { recursive: true });
fs.writeFileSync(path.join(labRoot, "experiments", "exp_001.json"),
  JSON.stringify({ id: "exp_001", signal_id: "signal_001", signal_version: 1, status: "created" }));
fs.writeFileSync(path.join(labRoot, "experiments", "legacy-stub.json"),
  JSON.stringify({ id: "legacy-stub", summary: "qlib 探索遗留，非生命周期实验" }));
fs.writeFileSync(path.join(labRoot, "experiments", "index.json"), JSON.stringify({ experiments: [] }));

test("合法 JSON 文件解析为 file", () => {
  const r = resolveRequest("/api/trading/market/2026-08-17/index_spot.json", dataRoot);
  assert.equal(r.kind, "file");
});

test("latest 端点", () => {
  assert.equal(resolveRequest("/api/trading/latest.json", dataRoot).kind, "latest");
  assert.equal(latestDate(dataRoot), "2026-08-17");
});

test("latest 回落到最近有数据的交易日（盘前/管道未跑场景）", () => {
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "td-route2-"));
  fs.mkdirSync(path.join(tmp2, "calendar"), { recursive: true });
  fs.writeFileSync(path.join(tmp2, "calendar", "trade_dates.json"),
    JSON.stringify(["2026-08-14", "2026-08-17"]));
  // 只有 08-14 有数据；08-17 是最近交易日但盘前无数据 → 必须回落
  fs.mkdirSync(path.join(tmp2, "market", "2026-08-14"), { recursive: true });
  fs.writeFileSync(path.join(tmp2, "market", "2026-08-14", "index_spot.json"), "{}");
  assert.equal(latestDate(tmp2), "2026-08-14");
  fs.rmSync(tmp2, { recursive: true, force: true });
});

test("latest 完全没有数据时返回 null（管道从未运行，前端空态）", () => {
  const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), "td-route3-"));
  fs.mkdirSync(path.join(tmp3, "calendar"), { recursive: true });
  fs.writeFileSync(path.join(tmp3, "calendar", "trade_dates.json"), JSON.stringify(["2026-08-17"]));
  assert.equal(latestDate(tmp3), null);
  fs.rmSync(tmp3, { recursive: true, force: true });
});

test("非 JSON 拒绝", () => {
  assert.equal(resolveRequest("/api/trading/market/2026-08-17/index_spot.txt", dataRoot).status, 404);
});

test("路径越界拒绝（404/403 均可，绝不返回文件）", () => {
  for (const u of ["/api/trading/../../etc/passwd.json",
                   "/api/trading/..%2F..%2Fetc%2Fpasswd.json",
                   "/api/trading/%2e%2e/%2e%2e/etc/passwd.json"]) {
    const r = resolveRequest(u, dataRoot);
    assert.ok([403, 404].includes(r.status), `${u} → ${r.status}`);
    assert.notEqual(r.kind, "file");
  }
});

test("缺失文件 404 / 未知路由 404", () => {
  assert.equal(resolveRequest("/api/trading/market/2026-08-17/nope.json", dataRoot).status, 404);
  assert.equal(resolveRequest("/api/other/x.json", dataRoot).status, 404);
});

test("lab 列表（白名单扫描，越界不可达）", () => {
  const lab = resolveLab(labRoot);
  assert.equal(lab.ideas.length, 1);
  assert.equal(lab.ideas[0].id, "idea_001");
  assert.ok(lab.signals.signal_001);
  assert.equal(lab.signals.signal_001.version, 1);
});

test("lab 列表：experiments 只收生命周期实验（有 signal_id），跳过 legacy stub / index.json", () => {
  const lab = resolveLab(labRoot);
  assert.deepEqual(lab.experiments.map((e) => e.id), ["exp_001"]);
});

test("个股日线：非法 symbol 拒绝，合法 symbol 走导出", () => {
  assert.equal(stockDaily("../etc/passwd", tmp, "python3").status, 400);
  assert.equal(stockDaily("600519", tmp, "python3").status, 400);        // 缺前缀
  assert.equal(stockDaily("sh600519&x", tmp, "python3").status, 400);    // 注入
  // 合法 symbol 且 python 缺失 → python_missing（不执行任何命令）
  assert.equal(stockDaily("sh600519", tmp, "/nonexistent/python").status, 500);
});

test("聚合日线：路径识别 + 非法 symbol 过滤 + 上限", () => {
  const r = resolveRequest("/api/trading/aggregate.json?symbols=sh601398,sz002074&name=%E6%8C%81%E4%BB%93", dataRoot);
  assert.equal(r.kind, "aggregate");
  assert.equal(r.symbols, "sh601398,sz002074");
  assert.equal(r.name, "持仓");
  // 非法 symbol（无前缀/注入/脏字符）全部过滤 → bad_symbols；python 缺失 → 500
  assert.equal(aggregateDaily("600519,sh600519&x", "t", tmp, "python3").status, 400);
  assert.equal(aggregateDaily("bad", "t", tmp, "python3").status, 400);
  // 合法列表 + python 缺失 → python_missing
  const out = aggregateDaily("sh601398,sz002074", "t", tmp, "/nonexistent/python");
  assert.equal(out.status, 500);
  assert.equal(out.error, "python_missing");
});

test.after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
