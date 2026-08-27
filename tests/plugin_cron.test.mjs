/* 全局定时任务服务测试：到期判定 / 交易日跳过 / 当日不重复 / 间隔最小 5 分钟 / 停用。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { isDue, isTradingDay, nowParts } = require("../plugins/trading-dashboard/src/cron.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "td-cron-"));
const cal = path.join(tmp, "trade_dates.json");
fs.writeFileSync(cal, JSON.stringify(["2026-08-17", "2026-08-18", "2026-08-19"])); // 周一~周三

const t = (over) => ({
  id: "x", name: "x", enabled: true, tz: "Asia/Shanghai",
  schedule: { type: "daily", time: "16:45" },
  command: "/bin/true", args: [], last_run: null, last_status: null,
  ...over,
});

test("daily：未到点不触发，到点触发", () => {
  const before = new Date("2026-08-18T16:00:00+08:00");
  const after = new Date("2026-08-18T16:46:00+08:00");
  assert.equal(isDue(t({}), before, cal), false);
  assert.equal(isDue(t({}), after, cal), true);
});

test("daily：当天已成功跑过不重复（补跑保护）", () => {
  const after = new Date("2026-08-18T17:00:00+08:00");
  const ran = t({ last_run: "2026-08-18T16:45:30+08:00", last_status: "success" });
  assert.equal(isDue(ran, after, cal), false);
  const failed = t({ last_run: "2026-08-18T16:45:30+08:00", last_status: "failed" });
  assert.equal(isDue(failed, after, cal), true, "失败允许当天重跑");
});

test("daily_trading：非交易日跳过（日历含 08-19 周二 → 触发；周末不触发）", () => {
  const tue = new Date("2026-08-19T16:46:00+08:00");
  const sat = new Date("2026-08-22T16:46:00+08:00");
  const task = t({ schedule: { type: "daily_trading", time: "16:45" } });
  assert.equal(isDue(task, tue, cal), true);
  assert.equal(isDue(task, sat, cal), false);
});

test("daily_trading：无日历文件回退周一~周五", () => {
  const sat = new Date("2026-08-22T16:46:00+08:00");
  const mon = new Date("2026-08-24T16:46:00+08:00");
  const task = t({ schedule: { type: "daily_trading", time: "16:45" } });
  assert.equal(isDue(task, sat, "/nonexistent.json"), false);
  assert.equal(isDue(task, mon, "/nonexistent.json"), true);
});

test("interval_minutes：间隔生效且最小 5 分钟", () => {
  const task = t({ schedule: { type: "interval_minutes", interval: 1 } });
  const now = new Date("2026-08-18T10:00:00+08:00");
  assert.equal(isDue({ ...task, last_run: null }, now, cal), true, "首次立即触发");
  const ran = { ...task, last_run: "2026-08-18T09:59:00+08:00", last_status: "success" };
  assert.equal(isDue(ran, now, cal), false, "1 分钟被钳制到 5 分钟 → 未到");
  const ran6 = { ...task, last_run: "2026-08-18T09:54:00+08:00", last_status: "success" };
  assert.equal(isDue(ran6, now, cal), true);
});

test("disabled 永不触发", () => {
  const now = new Date("2026-08-18T17:00:00+08:00");
  assert.equal(isDue(t({ enabled: false }), now, cal), false);
});

test("isTradingDay 直接判定", () => {
  assert.equal(isTradingDay("2026-08-18", cal), true);
  assert.equal(isTradingDay("2026-08-22", cal), false);
  assert.equal(isTradingDay("2026-08-23", "/nonexistent.json"), false);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
