/* 新闻合并纯函数测试：真实文件合并 20 条快讯 + 空数据处理 + 排序。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { mergeNewsItems } = require("../plugins/trading-dashboard/src/client/validate.js");

test("真实 08-18 事件文件：合并出 20 条快讯 + 0 公告，按日期倒序", () => {
  const real = JSON.parse(fs.readFileSync(
    "/Users/bhn/Desktop/funny_project/trading/data/events/2026-08-18/announcements.json", "utf8"));
  const items = mergeNewsItems(real);
  assert.equal(items.length, 20);
  assert.ok(items.every((i) => i.source !== "cninfo"), "无公告时全为快讯");
  const dates = items.map((i) => i.date).filter(Boolean);
  for (let i = 1; i < dates.length; i++) {
    assert.ok(dates[i - 1] >= dates[i], "按日期倒序");
  }
  assert.ok(items[0].title.length > 0, "快讯有标题");
});

test("空数据返回空数组，不抛异常", () => {
  assert.deepEqual(mergeNewsItems(null), []);
  assert.deepEqual(mergeNewsItems({ data: {} }), []);
  assert.deepEqual(mergeNewsItems({ data: { announcements: [], flashes: [] } }), []);
});
